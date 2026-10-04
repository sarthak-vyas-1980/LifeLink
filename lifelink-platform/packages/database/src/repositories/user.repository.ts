import { Prisma, UserStatus } from "@prisma/client";
import { database } from "../client";

export function findUserById(id: string) {
  return database.user.findUnique({
    where: { id },
    include: { institution: true, hospitalProfile: true, donorProfile: true },
  });
}

export function findUserByEmail(email: string) {
  return database.user.findUnique({ where: { email } });
}

export function createUser(data: Prisma.UserCreateInput) {
  return database.user.create({ data });
}

export function saveUser(id: string, data: Prisma.UserUpdateInput) {
  return database.user.update({ where: { id }, data });
}

export function updateUserStatus(id: string, status: UserStatus) {
  return database.user.update({ where: { id }, data: { status } });
}
