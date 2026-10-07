import bcrypt from "bcryptjs";
import { BloodGroup, ConsentStatus, OrganAuthorizationStatus, OrganDonorStatus, OrganRecipientStatus, OrganType, RequestPriority, UserRole, UserStatus } from "@prisma/client";
import { database } from "@lifelink/database";

if (process.env.LIFELINK_ALLOW_DEMO_SEED !== "YES") {
	throw new Error("Set LIFELINK_ALLOW_DEMO_SEED=YES to add synthetic Indore demo data.");
}

const demoPassword = "IndoreDemo!2026";
const institutions = [
	{ key: "bombay", name: "Bombay Hospital Indore", address: "Eastern Ring Road, IDA Scheme No. 94/95, Tulsi Nagar, Indore, Madhya Pradesh 452010", latitude: 22.757979, longitude: 75.902796 },
	{ key: "choithram", name: "Choithram Hospital & Research Centre", address: "Manik Bagh Road, Indore, Madhya Pradesh 452014", latitude: 22.687704, longitude: 75.8536 },
	{ key: "care-chl", name: "CARE CHL Hospitals Indore", address: "AB Road, near L.I.G. Square, Indore, Madhya Pradesh 452008", latitude: 22.7276, longitude: 75.8890 },
	{ key: "arihant", name: "Arihant Hospital & Research Centre", address: "283-A, Gumasta Nagar, Indore, Madhya Pradesh 452009", latitude: 22.703118, longitude: 75.822951 },
	{ key: "my-hospital", name: "M.Y. Hospital Indore", address: "A.B. Road, near MGM Medical College, Indore, Madhya Pradesh 452001", latitude: 22.71353, longitude: 75.87956 },
	{ key: "shalby", name: "Shalby Multispecialty Hospital Indore", address: "Part 5 & 6, R.S. Bhandari Marg, Race Course Road, Janjeerwala Square, Indore, Madhya Pradesh 452003", latitude: 22.728721, longitude: 75.877332 },
	{ key: "saims", name: "Sri Aurobindo Hospital Indore", address: "Indore-Ujjain Highway, Bhawrasla, Indore, Madhya Pradesh 453555", latitude: 22.796845, longitude: 75.844913 },
	{ key: "medanta", name: "Medanta Super Speciality Hospital Indore", address: "Plot No. 8, PU-4, Scheme No. 54, Vijay Nagar Square, A.B. Road, Indore, Madhya Pradesh 452010", latitude: 22.7489, longitude: 75.8960 },
] as const;

const organCentres = [
	{ key: "apollo-organ-centre", name: "Apollo Hospitals Indore", address: "Sector-D, Vijay Nagar, Scheme No. 74C, Indore, Madhya Pradesh 452010", latitude: 22.7517, longitude: 75.8920, programs: ["KIDNEY", "LIVER"] },
	{ key: "care-chl-organ-centre", name: "CARE CHL Hospitals Indore", address: "A.B. Road, near L.I.G. Square, Indore, Madhya Pradesh 452008", latitude: 22.7276, longitude: 75.8890, programs: ["KIDNEY", "LIVER"] },
	{ key: "shalby-organ-centre", name: "Shalby Multispecialty Hospital Indore", address: "Part 5 & 6, R.S. Bhandari Marg, Race Course Road, Janjeerwala Square, Indore, Madhya Pradesh 452003", latitude: 22.728721, longitude: 75.877332, programs: ["KIDNEY", "LIVER"] },
] as const;

async function main() {
	const passwordHash = await bcrypt.hash(demoPassword, 12);
	const demoUser = await database.user.upsert({
		where: { email: "indore.demo.user@lifelink.test" },
		create: { name: "Indore Demo User (Synthetic)", email: "indore.demo.user@lifelink.test", phone: "+919000000001", passwordHash, role: UserRole.USER, status: UserStatus.ACTIVE },
		update: { name: "Indore Demo User (Synthetic)", phone: "+919000000001", passwordHash, role: UserRole.USER, status: UserStatus.ACTIVE },
	});

	const institutionByKey = new Map<string, { id: string }>();
	for (const item of institutions) {
		const name = `${item.name} (LifeLink Demo)`;
		const prior = await database.institution.findFirst({ where: { name, contactPerson: "LifeLink synthetic demo dataset" } });
		const institution = prior
			? await database.institution.update({ where: { id: prior.id }, data: { address: item.address, latitude: item.latitude, longitude: item.longitude, status: "ACTIVE" } })
			: await database.institution.create({ data: { name, type: "HOSPITAL", address: item.address, latitude: item.latitude, longitude: item.longitude, contactPerson: "LifeLink synthetic demo dataset", status: "ACTIVE", hospitalProfile: { create: { hospitalType: "SYNTHETIC DEMO SERVICE", organService: { create: { transplantFacility: false, transplantPrograms: ["DEMO DATA ONLY"] } } } } } });
		await database.hospitalProfile.upsert({ where: { institutionId: institution.id }, create: { institutionId: institution.id, hospitalType: "SYNTHETIC DEMO SERVICE" }, update: {} });
		await database.hospitalOrganService.upsert({ where: { hospitalId: (await database.hospitalProfile.findUniqueOrThrow({ where: { institutionId: institution.id }, select: { id: true } })).id }, create: { hospitalId: (await database.hospitalProfile.findUniqueOrThrow({ where: { institutionId: institution.id }, select: { id: true } })).id, transplantFacility: false, transplantPrograms: ["DEMO DATA ONLY"] }, update: {} });
		const email = `demo.${item.key}@lifelink.test`;
		await database.institutionAccount.upsert({ where: { email }, create: { institutionId: institution.id, email, phone: "+919000000100", passwordHash }, update: { institutionId: institution.id, phone: "+919000000100", passwordHash } });
		institutionByKey.set(item.key, institution);
	}

	for (const centre of organCentres) {
		const name = `${centre.name} (LifeLink Demo Organ Centre)`;
		const prior = await database.institution.findFirst({ where: { name, contactPerson: "LifeLink synthetic demo dataset" } });
		const institution = prior
			? await database.institution.update({ where: { id: prior.id }, data: { address: centre.address, latitude: centre.latitude, longitude: centre.longitude, status: "ACTIVE", type: "ORGAN_CENTRE" } })
			: await database.institution.create({ data: { name, type: "ORGAN_CENTRE", address: centre.address, latitude: centre.latitude, longitude: centre.longitude, contactPerson: "LifeLink synthetic demo dataset", status: "ACTIVE", organCentreProfile: { create: { centreType: "LIFELINK DEMO ORGAN CENTRE", transplantPrograms: [...centre.programs] } } } });
		await database.organCentreProfile.upsert({ where: { institutionId: institution.id }, create: { institutionId: institution.id, centreType: "LIFELINK DEMO ORGAN CENTRE", transplantPrograms: [...centre.programs] }, update: { centreType: "LIFELINK DEMO ORGAN CENTRE", transplantPrograms: [...centre.programs] } });
		const email = `demo.${centre.key}@lifelink.test`;
		await database.institutionAccount.upsert({ where: { email }, create: { institutionId: institution.id, email, phone: "+919000000101", passwordHash }, update: { institutionId: institution.id, phone: "+919000000101", passwordHash } });
	}

	const donorSpecs = [
		{ reference: "DNR-IND-DEMO-001", organType: OrganType.KIDNEY, bloodGroup: BloodGroup.O_POSITIVE, institutionKey: "bombay", donorType: "LIVING" },
		{ reference: "DNR-IND-DEMO-002", organType: OrganType.LIVER, bloodGroup: BloodGroup.A_POSITIVE, institutionKey: "choithram", donorType: "POSTHUMOUS_INTENT" },
		{ reference: "DNR-IND-DEMO-003", organType: OrganType.HEART, bloodGroup: BloodGroup.B_POSITIVE, institutionKey: "care-chl", donorType: "POSTHUMOUS_INTENT" },
		{ reference: "DNR-IND-DEMO-004", organType: OrganType.LUNG, bloodGroup: BloodGroup.AB_POSITIVE, institutionKey: "arihant", donorType: "POSTHUMOUS_INTENT" },
	] as const;
	for (const [index, spec] of donorSpecs.entries()) {
		if (await database.organDonor.findUnique({ where: { reference: spec.reference } })) continue;
		const institution = institutionByKey.get(spec.institutionKey)!;
		const createdAt = new Date(Date.now() - (index + 1) * 86_400_000);
		await database.organDonor.create({ data: {
			reference: spec.reference, userId: demoUser.id, institutionId: institution.id, donorType: spec.donorType, organType: spec.organType,
			bloodGroup: spec.bloodGroup, status: OrganDonorStatus.REGISTERED, consentStatus: ConsentStatus.PENDING,
			authorizationStatus: OrganAuthorizationStatus.PENDING, createdAt, updatedAt: createdAt,
			consents: { create: { consentType: spec.donorType, status: ConsentStatus.PENDING, notes: "Synthetic test request. No real consent or authorization has been obtained.", createdAt } },
		} });
	}

	const recipientSpecs = [
		{ reference: "RCPT-IND-DEMO-001", organType: OrganType.PANCREAS, bloodGroup: BloodGroup.O_POSITIVE, priority: RequestPriority.NORMAL, institutionKey: "my-hospital" },
		{ reference: "RCPT-IND-DEMO-002", organType: OrganType.INTESTINE, bloodGroup: BloodGroup.A_NEGATIVE, priority: RequestPriority.URGENT, institutionKey: "shalby" },
		{ reference: "RCPT-IND-DEMO-003", organType: OrganType.CORNEA, bloodGroup: null, priority: RequestPriority.NORMAL, institutionKey: "saims" },
		{ reference: "RCPT-IND-DEMO-004", organType: OrganType.BONE_MARROW, bloodGroup: BloodGroup.B_POSITIVE, priority: RequestPriority.EMERGENCY, institutionKey: "medanta" },
	] as const;
	for (const [index, spec] of recipientSpecs.entries()) {
		if (await database.organRecipient.findUnique({ where: { reference: spec.reference } })) continue;
		const institution = institutionByKey.get(spec.institutionKey)!;
		const createdAt = new Date(Date.now() - (index + 1) * 43_200_000);
		await database.organRecipient.create({ data: {
			reference: spec.reference, userId: demoUser.id, institutionId: institution.id, organType: spec.organType, bloodGroup: spec.bloodGroup,
			priority: spec.priority, status: OrganRecipientStatus.PENDING_REVIEW, registrationDate: createdAt, createdAt, updatedAt: createdAt,
			requirement: { create: { organType: spec.organType, bloodGroup: spec.bloodGroup, priority: spec.priority, urgency: "SYNTHETIC DEMO DATA" } },
		} });
	}

	const [institutionCount, donorCount, recipientCount] = await Promise.all([
		database.institution.count({ where: { contactPerson: "LifeLink synthetic demo dataset" } }),
		database.organDonor.count({ where: { userId: demoUser.id, reference: { startsWith: "DNR-IND-DEMO-" } } }),
		database.organRecipient.count({ where: { userId: demoUser.id, reference: { startsWith: "RCPT-IND-DEMO-" } } }),
	]);
	console.info(`Indore demo seed complete: ${institutionCount} marked demo institutions (${institutions.length} hospitals, ${organCentres.length} organ centres), ${donorCount} donor requests, ${recipientCount} recipient requests.`);
	console.info(`Personal demo login: indore.demo.user@lifelink.test / ${demoPassword}`);
	console.info(`Institution demo login pattern: demo.<institution-key>@lifelink.test / ${demoPassword}`);
}

main().catch((error: unknown) => {
	console.error("Indore demo seed failed.", error instanceof Error ? error.message : "Unknown error");
	process.exitCode = 1;
}).finally(async () => database.$disconnect());
