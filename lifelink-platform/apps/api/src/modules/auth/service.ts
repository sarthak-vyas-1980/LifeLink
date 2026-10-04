import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { UserRole, UserStatus } from "@prisma/client";
import {
  createUser,
  findUserByEmail,
  saveUser,
  updateUserStatus,
} from "@lifelink/database";
import { getRuntimeConfig } from "../../config";
import { recordAuditEvent } from "../audit/service";

export interface RegistrationInput {
  name: string;
  email: string;
  phone?: string;
  password: string;
  role: UserRole;
  institutionId?: string;
}

function issueToken(user: {
  id: string;
  role: UserRole;
  institutionId: string | null;
}) {
  const config = getRuntimeConfig();
  return jwt.sign(
    { role: user.role, institutionId: user.institutionId ?? undefined },
    config.jwtSecret,
    {
      subject: user.id,
      expiresIn: config.jwtExpiresIn as jwt.SignOptions["expiresIn"],
    },
  );
}

// Register an account with a hashed credential and audit trail.
export async function registerUser(input: RegistrationInput) {
  const passwordHash = await bcrypt.hash(input.password, 12);
  const user = await createUser({
    name: input.name,
    email: input.email.toLowerCase().trim(),
    phone: input.phone,
    passwordHash,
    role: input.role,
    institution: input.institutionId
      ? { connect: { id: input.institutionId } }
      : undefined,
  });

  await recordAuditEvent({
    actorId: user.id,
    action: "USER_REGISTERED",
    entityType: "User",
    entityId: user.id,
    metadata: { role: user.role },
  });

  return { user, token: issueToken(user) };
}

// Authenticate credentials and return a role-aware session context.
export async function loginUser(email: string, password: string) {
  const user = await findUserByEmail(email.toLowerCase().trim());
  const valid = user
    ? await bcrypt.compare(password, user.passwordHash)
    : false;

  if (!user || !valid || user.status !== UserStatus.ACTIVE) {
    throw new Error("Invalid credentials.");
  }

  await recordAuditEvent({
    actorId: user.id,
    action: "USER_LOGIN",
    entityType: "User",
    entityId: user.id,
    metadata: { role: user.role },
  });

  return { user, token: issueToken(user) };
}

// Restrict or deactivate an account through an authorized administrative service.
export async function setUserStatus(
  userId: string,
  status: UserStatus,
  actorId: string,
) {
  const user = await updateUserStatus(userId, status);
  await recordAuditEvent({
    actorId,
    action: "USER_STATUS_CHANGED",
    entityType: "User",
    entityId: userId,
    metadata: { status },
  });
  return user;
}

// Update a permitted profile field without accepting credentials as profile data.
export function updateUserProfile(
  userId: string,
  data: { name?: string; phone?: string },
) {
  return saveUser(userId, data);
}
