import { isValidMapCoordinates } from "./map-layout";

export type MarkerKind = "hospital" | "emergency" | "clinic" | "pharmacy" | "blood" | "organ" | "other";

export function markerKind(type: string): MarkerKind {
  return type === "BLOOD_BANK" ? "blood"
    : type === "ORGAN_CENTRE" ? "organ"
      : type === "CLINIC" ? "clinic"
        : type === "PHARMACY" ? "pharmacy"
          : type === "EMERGENCY_DEPARTMENT" ? "emergency"
            : type === "HOSPITAL" ? "hospital" : "other";
}

/** A `tel:` link only for a plausible phone number; never built from names or other fields. */
export function safePhoneHref(value: string | null | undefined): string | null {
  const phone = value?.trim();
  if (!phone || !/^[+\d().\-\s]+$/.test(phone)) return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  return `tel:${phone.startsWith("+") ? "+" : ""}${digits}`;
}

/**
 * External directions to verified coordinates. These open the user's map app or browser;
 * LifeLink itself does not compute routes or travel times.
 */
export function directionsLinks(latitude: number | null | undefined, longitude: number | null | undefined): { google: string | null; openStreetMap: string | null } {
  if (!isValidMapCoordinates([latitude, longitude])) return { google: null, openStreetMap: null };
  const destination = `${latitude!.toFixed(6)},${longitude!.toFixed(6)}`;
  return {
    google: `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}`,
    openStreetMap: `https://www.openstreetmap.org/directions?to=${encodeURIComponent(destination)}`,
  };
}
