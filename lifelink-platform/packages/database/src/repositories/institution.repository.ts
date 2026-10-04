import { Prisma } from "@prisma/client";
import { database } from "../client";

export function findInstitutionById(id: string) {
  return database.institution.findUnique({
    where: { id },
    include: { users: true, hospitalUsers: true },
  });
}

export function createInstitution(data: Prisma.InstitutionCreateInput) {
  return database.institution.create({ data });
}

export function saveInstitution(
  id: string,
  data: Prisma.InstitutionUpdateInput,
) {
  return database.institution.update({ where: { id }, data });
}

export function searchInstitutions(
  where: Prisma.InstitutionWhereInput,
  take = 100,
) {
  return database.institution.findMany({
    where,
    orderBy: [{ status: "asc" }, { name: "asc" }],
    take,
  });
}
