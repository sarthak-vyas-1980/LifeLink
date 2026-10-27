import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { io } from "socket.io-client";
import { apiUrl, call, closeAccounts, e2eSkip, register, type Account } from "./support";

// End-to-end acceptance of LL-FR-BREQ, LL-FR-INV, LL-FR-EMG, LL-FR-RTN and LL-FR-AUTH
// through the deployed HTTP API and Socket.IO gateway, exactly as the web app uses them.

describe("blood request journey against a running deployment", { skip: e2eSkip }, () => {
  after(closeAccounts);

  test("E2E-01 hospital request -> provider confirmation -> reservation -> fulfilment, with access control at each step", async () => {
    const hospital = await register("HOSPITAL", "Requesting Hospital", { bloodServiceEnabled: true });
    const bank = await register("BLOOD_BANK", "Provider Bank");
    const otherBank = await register("BLOOD_BANK", "Unrelated Bank");
    const outsider = await register("USER", "Outsider Person");

    const stock = await call("POST", "/api/inventory/blood", { token: bank.token, body: {
      institutionId: bank.id, bloodGroup: "AB_NEGATIVE", component: "CRYOPRECIPITATE", unitsAvailable: 8,
      expiryDate: new Date(Date.now() + 14 * 86_400_000).toISOString(),
    } });
    assert.equal(stock.status, 201);
    const inventoryId: string = stock.body.id;

    const live = await listenForWorkflowEvents(hospital);
    const created = await call("POST", "/api/requests/blood", { token: hospital.token, body: {
      bloodGroup: "AB_NEGATIVE", component: "CRYOPRECIPITATE", quantity: 3, priority: "URGENT", location: "E2E Emergency Ward", contactNumber: "+911234567890",
    } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const requestId: string = created.body.request.id;
    assert.equal(created.body.request.status, "INSTITUTIONS_NOTIFIED");
    const candidate = created.body.matching.candidates.find((item: any) => item.inventoryId === inventoryId);
    assert.ok(candidate, "the provider's stock is offered as a candidate");
    assert.equal(candidate.guaranteedFulfilment, false);

    assert.equal((await call("GET", `/api/requests/blood/${requestId}`, { token: outsider.token })).status, 404, "unrelated users cannot see the request");
    assert.equal((await call("GET", `/api/requests/blood/${requestId}`, { token: otherBank.token })).status, 404, "unrelated institutions cannot see the request");
    const providerView = await call("GET", `/api/requests/blood/${requestId}`, { token: bank.token });
    assert.equal(providerView.status, 200);
    assert.equal("contactNumber" in providerView.body, false, "the patient-side contact number is not shared with providers");

    const respond = (account: Account, action: string) => call("POST", `/api/requests/blood/${requestId}/offers/${candidate.matchId}/respond`, { token: account.token, body: { action } });
    assert.equal((await respond(otherBank, "ACCEPT")).status, 403);
    assert.equal((await respond(bank, "ACCEPT")).status, 200);
    assert.equal((await respond(bank, "ACCEPT")).status, 409, "an offer is answered once");

    const evaluated = await call("POST", `/api/requests/blood/${requestId}/offers/${candidate.matchId}/evaluate`, { token: hospital.token, body: { action: "ACCEPT" } });
    assert.equal(evaluated.status, 200);
    assert.equal(evaluated.body.outcome, "RESERVED");
    const holdMinutes = (new Date(evaluated.body.reservationExpiresAt).getTime() - Date.now()) / 60_000;
    assert.ok(holdMinutes > 0 && holdMinutes <= 1440, `reservation hold of ${holdMinutes} minutes`);
    const unitsLeft = async () => (await call("GET", `/api/inventory/blood?institutionId=${bank.id}`, { token: bank.token })).body.records.find((record: any) => record.id === inventoryId)?.unitsAvailable;
    assert.equal(await unitsLeft(), 5, "3 of 8 units are held for the request");

    assert.equal((await call("POST", `/api/requests/blood/${requestId}/fulfill`, { token: otherBank.token })).status, 403);
    assert.equal((await call("POST", `/api/requests/blood/${requestId}/fulfill`, { token: hospital.token })).status, 403);
    const fulfilled = await call("POST", `/api/requests/blood/${requestId}/fulfill`, { token: bank.token });
    assert.equal(fulfilled.status, 200);
    assert.equal(fulfilled.body.status, "FULFILLED");
    assert.equal(await unitsLeft(), 5, "fulfilment consumes the held units without touching the rest");
    assert.equal((await call("POST", `/api/requests/blood/${requestId}/cancel`, { token: hospital.token })).status, 409, "a fulfilled request cannot be cancelled");

    const inbox = await call("GET", "/api/notifications?limit=100", { token: hospital.token });
    assert.ok(inbox.body.notifications.some((item: any) => item.requestId === requestId), "status changes are persisted to the requester's inbox");
    const pushed = await live.received(requestId);
    live.close();
    assert.ok(pushed, "at least one workflow event was pushed live over Socket.IO");
  });

  test("E2E-02 emergency requests always carry EMERGENCY priority, whatever the client sends", async () => {
    const hospital = await register("HOSPITAL", "Emergency Hospital", { bloodServiceEnabled: true });
    const created = await call("POST", "/api/emergency/blood-requests", { token: hospital.token, body: {
      bloodGroup: "O_NEGATIVE", component: "RED_BLOOD_CELLS", quantity: 1, priority: "NORMAL", location: "E2E Trauma Bay", contactNumber: "+911234567890",
    } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.request.priority, "EMERGENCY");
    assert.equal(created.body.coordinationOnly, true);
    await call("POST", `/api/requests/blood/${created.body.request.id}/cancel`, { token: hospital.token });
  });

  test("E2E-03 sessions end at logout boundaries and unauthenticated calls are refused", async () => {
    const person = await register("USER", "Session Person");
    assert.equal((await call("GET", "/api/users/me", { token: person.token })).status, 200);
    assert.equal((await call("GET", "/api/users/me")).status, 401);
    await call("POST", "/api/auth/logout", { token: person.token });
    assert.equal((await call("GET", "/api/users/me", { token: person.token })).status, 401, "a logged-out token is revoked");
  });
});

function listenForWorkflowEvents(account: Account) {
  const socket = io(apiUrl!, { auth: { token: account.token }, transports: ["websocket"], reconnection: false });
  const events: Array<{ requestId: string | null }> = [];
  socket.on("workflow:event", (event: { requestId: string | null }) => events.push(event));
  return {
    async received(requestId: string, timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (events.some((event) => event.requestId === requestId)) return true;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return false;
    },
    close: () => socket.close(),
  };
}
