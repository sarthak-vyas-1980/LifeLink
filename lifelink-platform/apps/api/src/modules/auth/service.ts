import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { InstitutionStatus, InstitutionType, UserRole, UserStatus } from "@prisma/client";
import type { AccessRole } from "@lifelink/shared";
import {
  database,
  createInstitution,
  createUser,
  findInstitutionAccountByEmail,
  findUserByEmail,
  saveUser,
  updateUserStatus,
} from "@lifelink/database";
import { getRuntimeConfig } from "../../config";
import { recordAuditEvent } from "../audit/service";
import { ApiError } from "../../middleware/api-error";
import { ensureInstitutionCoordinates } from "../maps/geocoding.service";

export interface RegistrationInput {
  name: string;
  email: string;
  phone: string;
  password: string;
  accountType: "USER" | "INSTITUTION";
  institutionType?: InstitutionType;
  address?: string;
  contactPerson?: string;
  bloodServiceEnabled?: boolean;
  organServiceEnabled?: boolean;
  emergencySupportEnabled?: boolean;
}

interface InstitutionCapabilities { blood: boolean; organ: boolean }

function normalizePhoneNumber(value: string) {
  const digits = value.replace(/\D/g, "");
  // Treat Indian local, trunk-prefixed, and +91 formats as the same number.
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) return digits.slice(1);
  return digits;
}

function institutionalAccessRole(type: InstitutionType): AccessRole {
  return type === InstitutionType.HOSPITAL
    ? "HOSPITAL_USER"
    : type === InstitutionType.BLOOD_BANK
      ? "BLOOD_BANK_USER"
      : "ORGAN_CENTRE_USER";
}

function issueToken(subject: string, role: AccessRole, principalType: "USER" | "INSTITUTION", institutionId?: string, capabilities?: InstitutionCapabilities) {
  const config = getRuntimeConfig();
  return jwt.sign(
    { role, principalType, institutionId, capabilities },
    config.jwtSecret,
    {
      subject,
      expiresIn: config.jwtExpiresIn as jwt.SignOptions["expiresIn"],
    },
  );
}

export async function registerUser(input: RegistrationInput) {
  const passwordHash = await bcrypt.hash(input.password, 12);
  const normalizedEmail = input.email.toLowerCase().trim();

  // Keep soft-deleted history, but free its login email for a fresh registration.
  if (input.accountType === "INSTITUTION") {
    const oldAccount = await findInstitutionAccountByEmail(normalizedEmail);
    if (oldAccount?.institution.deletedAt) {
      await database.institutionAccount.update({ where: { id: oldAccount.id }, data: { email: `deleted+${oldAccount.id}@deleted.lifelink.invalid` } });
    }
  } else {
    const oldUser = await findUserByEmail(normalizedEmail);
    if (oldUser?.deletedAt) {
      await saveUser(oldUser.id, { email: `deleted+${oldUser.id}@deleted.lifelink.invalid` });
    }
  }

  if (input.accountType === "INSTITUTION") {
    if (!input.institutionType || !input.address?.trim()) {
      throw new ApiError(400, "INSTITUTION_DETAILS_REQUIRED", "Institution type and address are required.");
    }
    const institution = await createInstitution({
      name: input.name.trim(),
      type: input.institutionType,
      address: input.address.trim(),
      contactPerson: input.contactPerson?.trim(),
      contactNumber: input.phone,
      status: InstitutionStatus.ACTIVE,
      account: {
        create: {
          email: normalizedEmail,
          phone: input.phone,
          passwordHash,
        },
      },
      ...(input.institutionType === InstitutionType.HOSPITAL
        ? { hospitalProfile: { create: {
            emergencySupport: Boolean(input.emergencySupportEnabled),
            ...(input.bloodServiceEnabled ? { bloodService: { create: {} } } : {}),
            ...(input.organServiceEnabled ? { organService: { create: {} } } : {}),
          } } }
        : {}),
    });
    void ensureInstitutionCoordinates(institution);
    const role = institutionalAccessRole(institution.type);
    const capabilities = {
      blood: institution.type === InstitutionType.BLOOD_BANK || (institution.type === InstitutionType.HOSPITAL && Boolean(input.bloodServiceEnabled)),
      organ: institution.type === InstitutionType.ORGAN_CENTRE || (institution.type === InstitutionType.HOSPITAL && Boolean(input.organServiceEnabled)),
    };
    await recordAuditEvent({
      actorInstitutionId: institution.id,
      action: "INSTITUTION_REGISTERED",
      entityType: "Institution",
      entityId: institution.id,
      metadata: { type: institution.type },
    });
    return {
      user: {
        id: institution.id,
        name: institution.name,
        email: normalizedEmail,
        phone: input.phone,
        passwordHash,
        role,
        institutionId: institution.id,
      },
      accessRole: role,
      principalType: "INSTITUTION" as const,
      capabilities,
      token: issueToken(institution.id, role, "INSTITUTION", institution.id, capabilities),
    };
  }

  // Public registration always creates a personal account; see scripts/create-admin.ts for administrators.
  const user = await createUser({
    name: input.name.trim(),
    email: normalizedEmail,
    phone: input.phone,
    passwordHash,
    role: UserRole.USER,
  });
  const role: AccessRole = user.role === UserRole.ADMIN ? "ADMINISTRATOR" : "USER";
  await recordAuditEvent({
    actorId: user.id,
    action: "USER_REGISTERED",
    entityType: "User",
    entityId: user.id,
    metadata: { role: user.role },
  });
  return { user, accessRole: role, principalType: "USER" as const, token: issueToken(user.id, role, "USER") };
}

export async function loginUser(
  email: string,
  phone: string,
  password: string,
  accountType: "USER" | "INSTITUTION",
) {
  const normalizedEmail = email.toLowerCase().trim();
  if (accountType === "INSTITUTION") {
    const account = await findInstitutionAccountByEmail(normalizedEmail);
    const valid = account
      ? (await bcrypt.compare(password, account.passwordHash)) &&
        normalizePhoneNumber(account.phone) === normalizePhoneNumber(phone)
      : false;
    if (!account || !valid || account.institution.deletedAt || account.institution.status !== InstitutionStatus.ACTIVE) {
      throw new ApiError(401, "AUTH_INVALID", "Invalid credentials.");
    }
    const role = institutionalAccessRole(account.institution.type);
    const capabilities = {
      blood: account.institution.type === InstitutionType.BLOOD_BANK || Boolean(account.institution.hospitalProfile?.bloodService),
      organ: account.institution.type === InstitutionType.ORGAN_CENTRE || Boolean(account.institution.hospitalProfile?.organService),
    };
    await recordAuditEvent({
      actorInstitutionId: account.institutionId,
      action: "INSTITUTION_LOGIN",
      entityType: "Institution",
      entityId: account.institutionId,
      metadata: { type: account.institution.type },
    });
    return {
      user: {
        id: account.institutionId,
        name: account.institution.name,
        email: account.email,
        phone: account.phone,
        passwordHash: account.passwordHash,
        role,
        institutionId: account.institutionId,
      },
      accessRole: role,
      principalType: "INSTITUTION" as const,
      capabilities,
      token: issueToken(account.institutionId, role, "INSTITUTION", account.institutionId, capabilities),
    };
  }

  const user = await findUserByEmail(normalizedEmail);
  const valid = user
    ? (await bcrypt.compare(password, user.passwordHash)) &&
      normalizePhoneNumber(user.phone) === normalizePhoneNumber(phone)
    : false;
  if (!user || !valid || user.deletedAt || user.status !== UserStatus.ACTIVE) {
    throw new ApiError(401, "AUTH_INVALID", "Invalid credentials.");
  }
  const role: AccessRole = user.role === UserRole.ADMIN ? "ADMINISTRATOR" : "USER";
  await recordAuditEvent({
    actorId: user.id,
    action: "USER_LOGIN",
    entityType: "User",
    entityId: user.id,
    metadata: { role: user.role },
  });
  return { user, accessRole: role, principalType: "USER" as const, token: issueToken(user.id, role, "USER") };
}

export async function setUserStatus(userId: string, status: UserStatus, actorId: string) {
  const user = await updateUserStatus(userId, status);
  await recordAuditEvent({ actorId, action: "USER_STATUS_CHANGED", entityType: "User", entityId: userId, metadata: { status } });
  return user;
}

export function updateUserProfile(userId: string, data: { name?: string; phone?: string }) {
  return saveUser(userId, data);
}
