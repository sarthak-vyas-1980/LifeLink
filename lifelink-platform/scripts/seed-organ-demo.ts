import { BloodGroup, ConsentStatus, OrganAuthorizationStatus, OrganDonorStatus, OrganOfferStatus, OrganStatus, OrganType, PreservationMethod, RequestPriority } from "@prisma/client";
import { database } from "@lifelink/database";

if (process.env.LIFELINK_ALLOW_DEMO_SEED !== "YES") {
	throw new Error("Set LIFELINK_ALLOW_DEMO_SEED=YES to seed synthetic organ demo data.");
}

async function main() {
	let centre = await database.institution.findFirst({ where: { name: "LifeLink Synthetic Demo Organ Centre", type: "ORGAN_CENTRE" } });
	centre ??= await database.institution.create({ data: { name: "LifeLink Synthetic Demo Organ Centre", type: "ORGAN_CENTRE", address: "Synthetic demo location, India", latitude: 28.6139, longitude: 77.209, status: "ACTIVE", contactPerson: "Demo Coordinator", organCentreProfile: { create: {} } } });
	const specs = [
		{ organType: OrganType.KIDNEY, donor: "DNR-DEMO-001", organ: "ORG-DEMO-KIDNEY-NORMAL", group: BloodGroup.O_POSITIVE, elapsedHours: 2 },
		{ organType: OrganType.LIVER, donor: "DNR-DEMO-002", organ: "ORG-DEMO-LIVER-WARNING", group: BloodGroup.A_POSITIVE, elapsedHours: 17 },
		{ organType: OrganType.HEART, donor: "DNR-DEMO-003", organ: "ORG-DEMO-HEART-CRITICAL", group: BloodGroup.B_POSITIVE, elapsedHours: 22 },
		{ organType: OrganType.CORNEA, donor: "DNR-DEMO-004", organ: "ORG-DEMO-CORNEA-EXPIRED", group: BloodGroup.AB_POSITIVE, elapsedHours: 25 },
	] as const;
	for (const spec of specs) {
		const policy = await database.organPreservationPolicy.findFirst({ where: { institutionId: centre.id, organType: spec.organType, method: PreservationMethod.STATIC_COLD_STORAGE } });
		if (!policy) await database.organPreservationPolicy.create({ data: { institutionId: centre.id, organType: spec.organType, method: PreservationMethod.STATIC_COLD_STORAGE, targetHours: 10, warningHours: 8, criticalHours: 3, maximumHours: 24, label: "DEMO / CONFIGURABLE - NOT A CLINICAL RULE" } });
		let donor = await database.organDonor.findUnique({ where: { reference: spec.donor } });
		donor ??= await database.organDonor.create({ data: { reference: spec.donor, institutionId: centre.id, donorType: spec.organType === OrganType.CORNEA ? "TISSUE_REFERRAL_DEMO" : "SYNTHETIC_DEMO", consentStatus: ConsentStatus.VERIFIED, authorizationStatus: OrganAuthorizationStatus.AUTHORIZED, consentDate: new Date(), authorizationDate: new Date(), status: OrganDonorStatus.ACTIVE, bloodGroup: spec.group, consents: { create: { consentType: "SYNTHETIC_DEMO_CONSENT", status: ConsentStatus.VERIFIED, recordedAt: new Date(), verifiedAt: new Date(), documentReference: "DEMO_ONLY_NO_REAL_DOCUMENT" } } } });
		const exists = await database.organRecord.findUnique({ where: { reference: spec.organ } });
		if (!exists) await database.organRecord.create({ data: { reference: spec.organ, donorId: donor.id, institutionId: centre.id, currentLocationId: centre.id, organType: spec.organType, bloodGroup: spec.group, status: OrganStatus.PRESERVING, retrievalTime: new Date(Date.now() - (spec.elapsedHours + 0.25) * 3_600_000), preservationStartTime: new Date(Date.now() - spec.elapsedHours * 3_600_000), coldIschemiaStart: new Date(Date.now() - spec.elapsedHours * 3_600_000), preservationMethod: PreservationMethod.STATIC_COLD_STORAGE, qualityStatus: "DEMO_RECORD_ONLY", medicalAssessmentStatus: "NOT_ASSESSED_BY_LIFELINK", notes: "Synthetic demo record. Not a real donor or clinical assessment." } });
	}
	const recipient = await database.organRecipient.findUnique({ where: { reference: "RCPT-DEMO-001" } }) ?? await database.organRecipient.create({ data: { reference: "RCPT-DEMO-001", institutionId: centre.id, organType: OrganType.KIDNEY, bloodGroup: BloodGroup.O_POSITIVE, priority: RequestPriority.EMERGENCY, requirement: { create: { organType: OrganType.KIDNEY, bloodGroup: BloodGroup.O_POSITIVE, priority: RequestPriority.EMERGENCY, latitude: 28.7041, longitude: 77.1025, maximumDistanceKm: 100, urgency: "DEMO_PRIORITY" } } } });
	const offerDonor = await database.organDonor.findUnique({ where: { reference: "DNR-DEMO-OFFER" } }) ?? await database.organDonor.create({ data: { reference: "DNR-DEMO-OFFER", institutionId: centre.id, donorType: "SYNTHETIC_DEMO", consentStatus: ConsentStatus.VERIFIED, authorizationStatus: OrganAuthorizationStatus.AUTHORIZED, status: OrganDonorStatus.ACTIVE, bloodGroup: BloodGroup.O_POSITIVE, consents: { create: { consentType: "SYNTHETIC_DEMO_CONSENT", status: ConsentStatus.VERIFIED, recordedAt: new Date(), verifiedAt: new Date(), documentReference: "DEMO_ONLY_NO_REAL_DOCUMENT" } } } });
	const kidney = await database.organRecord.findUnique({ where: { reference: "ORG-DEMO-KIDNEY-OFFER" } }) ?? await database.organRecord.create({ data: { reference: "ORG-DEMO-KIDNEY-OFFER", donorId: offerDonor.id, institutionId: centre.id, currentLocationId: centre.id, organType: OrganType.KIDNEY, bloodGroup: BloodGroup.O_POSITIVE, status: OrganStatus.OFFERED, destinationCentreId: centre.id, notes: "Synthetic demo offer record." } });
	if (kidney) {
		const match = await database.organMatch.findFirst({ where: { organId: kidney.id, recipientId: recipient.id } }) ?? await database.organMatch.create({ data: { organId: kidney.id, recipientId: recipient.id, status: "SHORTLISTED", coordinationScore: 70, matchReasons: ["demo organ type matches", "demo configured group filter matches"], criteriaSnapshot: { demoOnly: true, clinicalDecision: false }, reviewedAt: new Date() } });
		const offerExists = await database.organOffer.findFirst({ where: { organId: kidney.id, recipientId: recipient.id } });
		if (!offerExists) await database.organOffer.create({ data: { reference: "OFF-DEMO-001", organId: kidney.id, recipientId: recipient.id, matchId: match.id, offeringCentreId: centre.id, receivingCentreId: centre.id, status: OrganOfferStatus.SENT, offeredAt: new Date(), responseDeadline: new Date(Date.now() + 4 * 3_600_000) } });
	}
	console.info("Synthetic organ demo data is ready. Preservation thresholds are configurable demonstrations, not clinical rules.");
}

main().catch((error: unknown) => { console.error("Synthetic demo seed failed.", error instanceof Error ? error.message : "Unknown error"); process.exitCode = 1; }).finally(async () => database.$disconnect());
