import bcrypt from "bcryptjs";
import { UserRole } from "@prisma/client";
import { database } from "@lifelink/database";

// Create an administrator, or promote an existing personal account. Public registration cannot do either.
// Usage:
//   LIFELINK_ADMIN_PASSWORD=... npm run admin:create -- --name "Asha Admin" --email asha@example.org --phone "+919800000000"
//   npm run admin:create -- --promote --email existing.user@example.org
function option(name: string) {
	const index = process.argv.indexOf(`--${name}`);
	return index >= 0 ? process.argv[index + 1]?.trim() : undefined;
}

async function main() {
	const email = option("email")?.toLowerCase();
	if (!email) throw new Error("Pass --email.");
	const existing = await database.user.findUnique({ where: { email } });

	if (process.argv.includes("--promote")) {
		if (!existing || existing.deletedAt) throw new Error(`No active personal account uses ${email}.`);
		await database.user.update({ where: { id: existing.id }, data: { role: UserRole.ADMIN } });
		await database.administrator.upsert({ where: { userId: existing.id }, create: { userId: existing.id }, update: {} });
		await database.auditLog.create({ data: { action: "USER_PROMOTED_TO_ADMIN", entityType: "User", entityId: existing.id, metadata: { via: "scripts/create-admin.ts" } } });
		console.info(`Promoted ${email} to administrator.`);
		return;
	}

	if (existing) throw new Error(`${email} is already registered. Use --promote to make it an administrator.`);
	const name = option("name");
	const phone = option("phone");
	const password = process.env.LIFELINK_ADMIN_PASSWORD;
	if (!name || !phone) throw new Error("Pass --name and --phone.");
	if (!password || password.length < 12) throw new Error("Set LIFELINK_ADMIN_PASSWORD to at least 12 characters.");
	const admin = await database.user.create({ data: { name, email, phone, passwordHash: await bcrypt.hash(password, 12), role: UserRole.ADMIN } });
	await database.administrator.create({ data: { userId: admin.id } });
	await database.auditLog.create({ data: { action: "ADMIN_CREATED", entityType: "User", entityId: admin.id, metadata: { via: "scripts/create-admin.ts" } } });
	console.info(`Created administrator ${email}.`);
}

main().catch((error: unknown) => {
	console.error("Admin creation failed.", error instanceof Error ? error.message : "Unknown error");
	process.exitCode = 1;
}).finally(async () => database.$disconnect());
