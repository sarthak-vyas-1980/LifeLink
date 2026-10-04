const earthRadiusKm = 6371;

// Calculate great-circle distance in kilometres between two coordinates.
export function calculateDistance(
  latitude1: number,
  longitude1: number,
  latitude2: number,
  longitude2: number,
) {
  const toRadians = (value: number) => (value * Math.PI) / 180;
  const latitudeDelta = toRadians(latitude2 - latitude1);
  const longitudeDelta = toRadians(longitude2 - longitude1);
  const value =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(toRadians(latitude1)) *
      Math.cos(toRadians(latitude2)) *
      Math.sin(longitudeDelta / 2) ** 2;

  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

// Rank facility results for a map or coordination search.
export function rankNearbyFacilities<T extends { distanceKm?: number }>(
  facilities: T[],
) {
  return [...facilities].sort(
    (first, second) =>
      (first.distanceKm ?? Number.POSITIVE_INFINITY) -
      (second.distanceKm ?? Number.POSITIVE_INFINITY),
  );
}

// Resolve the permitted geographic result set.
export function filterFacilitiesByRadius<T extends { distanceKm?: number }>(
  facilities: T[],
  radiusKm?: number,
) {
  if (radiusKm === undefined) {
    return facilities;
  }

  return facilities.filter(
    (facility) =>
      facility.distanceKm !== undefined && facility.distanceKm <= radiusKm,
  );
}
