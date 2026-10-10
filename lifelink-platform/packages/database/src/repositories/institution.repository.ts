import { Prisma } from "@prisma/client";
import { database } from "../client";

export function findInstitutionById(id: string) {
  return database.institution.findUnique({
    where: { id },
    include: {
      hospitalProfile: { include: { bloodService: true, organService: true } },
      bloodBankProfile: true,
      organCentreProfile: true,
    },
  });
}

export function findInstitutionAccessState(id: string) {
  return database.institution.findUnique({
    where: { id },
    select: { type: true, status: true },
  });
}

export function findInstitutionAccountByEmail(email: string) {
  return database.institutionAccount.findFirst({
    where: { email: { equals: email, mode: "insensitive" } },
    include: {
      institution: {
        include: {
          hospitalProfile: { include: { bloodService: true, organService: true } },
          bloodBankProfile: true,
          organCentreProfile: true,
        },
      },
    },
  });
}

export function createInstitution(data: Prisma.InstitutionCreateInput) {
  const specialization = data.type === "HOSPITAL"
    ? { hospitalProfile: data.hospitalProfile ?? { create: {} } }
    : data.type === "BLOOD_BANK"
      ? { bloodBankProfile: data.bloodBankProfile ?? { create: {} } }
      : { organCentreProfile: data.organCentreProfile ?? { create: {} } };
  return database.institution.create({ data: { ...data, ...specialization } });
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
