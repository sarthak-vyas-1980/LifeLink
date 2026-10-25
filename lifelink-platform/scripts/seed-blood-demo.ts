import bcrypt from "bcryptjs";
import { BloodComponent, BloodGroup, InstitutionType } from "@prisma/client";
import { database } from "@lifelink/database";

if (process.env.LIFELINK_ALLOW_DEMO_SEED !== "YES") {
	throw new Error("Set LIFELINK_ALLOW_DEMO_SEED=YES to add synthetic Indore blood demo data.");
}

const demoPassword = "BloodDemo!2026";
const demoMarker = "LifeLink synthetic blood demo dataset";
const providers = [
	{ key: "bloodbank-central", name: "Indore Central Blood Bank", type: InstitutionType.BLOOD_BANK, address: "M.G. Road, near Indore centre, Indore, Madhya Pradesh 452001", latitude: 22.7196, longitude: 75.8577, phone: "+919000001101" },
	{ key: "bloodbank-vijay-nagar", name: "Vijay Nagar Blood Centre", type: InstitutionType.BLOOD_BANK, address: "Scheme No. 54, Vijay Nagar, Indore, Madhya Pradesh 452010", latitude: 22.7489, longitude: 75.896, phone: "+919000001102" },
	{ key: "bombay-hospital", name: "Bombay Hospital Indore Blood Service", type: InstitutionType.HOSPITAL, address: "Eastern Ring Road, IDA Scheme No. 94/95, Tulsi Nagar, Indore, Madhya Pradesh 452010", latitude: 22.757979, longitude: 75.902796, phone: "+919000001103" },
	{ key: "choithram-hospital", name: "Choithram Hospital Blood Service", type: InstitutionType.HOSPITAL, address: "Manik Bagh Road, Indore, Madhya Pradesh 452014", latitude: 22.687704, longitude: 75.8536, phone: "+919000001104" },
] as const;

const stock = [
	{ bloodGroup: BloodGroup.O_POSITIVE, component: BloodComponent.RED_BLOOD_CELLS, units: 12 },
	{ bloodGroup: BloodGroup.O_POSITIVE, component: BloodComponent.WHOLE_BLOOD, units: 6 },
	{ bloodGroup: BloodGroup.O_POSITIVE, component: BloodComponent.PLATELETS, units: 6 },
	{ bloodGroup: BloodGroup.A_POSITIVE, component: BloodComponent.RED_BLOOD_CELLS, units: 8 },
	{ bloodGroup: BloodGroup.B_POSITIVE, component: BloodComponent.RED_BLOOD_CELLS, units: 8 },
	{ bloodGroup: BloodGroup.AB_POSITIVE, component: BloodComponent.RED_BLOOD_CELLS, units: 4 },
] as const;

async function main() {
	const passwordHash = await bcrypt.hash(demoPassword, 12);
	let createdStock = 0;
	const accounts: string[] = [];

	for (const provider of providers) {
		const name = `${provider.name} (LifeLink Demo)`;
		const prior = await database.institution.findFirst({ where: { name, contactPerson: demoMarker } });
		const institution = prior
			? await database.institution.update({ where: { id: prior.id }, data: { type: provider.type, address: provider.address, latitude: provider.latitude, longitude: provider.longitude, contactNumber: provider.phone, status: "ACTIVE", deletedAt: null } })
			: await database.institution.create({ data: { name, type: provider.type, address: provider.address, latitude: provider.latitude, longitude: provider.longitude, contactPerson: demoMarker, contactNumber: provider.phone, status: "ACTIVE" } });

		if (provider.type === InstitutionType.BLOOD_BANK) {
			await database.bloodBankProfile.upsert({ where: { institutionId: institution.id }, create: { institutionId: institution.id, operatingHours: "Demo data only · 24 hours" }, update: {} });
		} else {
			const profile = await database.hospitalProfile.upsert({ where: { institutionId: institution.id }, create: { institutionId: institution.id, hospitalType: "DEMO BLOOD SERVICE" }, update: {} });
			await database.hospitalBloodService.upsert({ where: { hospitalId: profile.id }, create: { hospitalId: profile.id, operatingHours: "Demo data only · 24 hours", serviceContact: provider.phone }, update: {} });
		}

		const email = `demo.${provider.key}@lifelink.test`;
		await database.institutionAccount.upsert({ where: { email }, create: { institutionId: institution.id, email, phone: provider.phone, passwordHash }, update: { institutionId: institution.id, phone: provider.phone, passwordHash } });
		accounts.push(email);

		for (const item of stock) {
			const existing = await database.bloodInventory.findFirst({ where: { institutionId: institution.id, bloodGroup: item.bloodGroup, component: item.component } });
			if (existing) continue;
			await database.bloodInventory.create({ data: { institutionId: institution.id, bloodGroup: item.bloodGroup, component: item.component, unitsAvailable: item.units, status: "AVAILABLE", expiryDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) } });
			createdStock += 1;
		}
	}

	console.info(`Blood demo seed complete: ${providers.length} synthetic providers, ${createdStock} new inventory records; existing stock was left unchanged.`);
	console.info(`Provider logins (all use ${demoPassword}): ${accounts.join(", ")}`);
}

main().catch((error: unknown) => {
	console.error("Blood demo seed failed.", error instanceof Error ? error.message : "Unknown error");
	process.exitCode = 1;
}).finally(async () => database.$disconnect());
