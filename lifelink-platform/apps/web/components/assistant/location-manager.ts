export type LocationPermissionState = "granted" | "prompt" | "denied" | "unsupported";
export interface DeviceCoordinates { latitude: number; longitude: number }

export async function readLocationPermission(permissions?: Pick<Permissions, "query">): Promise<LocationPermissionState> {
  if (!permissions) return "unsupported";
  try {
    const status = await permissions.query({ name: "geolocation" });
    return status.state === "granted" || status.state === "denied" ? status.state : "prompt";
  } catch {
    return "unsupported";
  }
}

export function requestFreshCoordinates(geolocation?: Pick<Geolocation, "getCurrentPosition">, timeoutMs = 10_000): Promise<DeviceCoordinates> {
  if (!geolocation) return Promise.reject(new Error("LOCATION_UNAVAILABLE"));
  return new Promise((resolve, reject) => {
    geolocation.getCurrentPosition(
      ({ coords }) => {
        const { latitude, longitude } = coords;
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
          reject(new Error("INVALID_COORDINATES"));
          return;
        }
        resolve({ latitude, longitude });
      },
      (error) => reject(new Error(error.code === 1 ? "LOCATION_DENIED" : error.code === 3 ? "LOCATION_TIMEOUT" : "LOCATION_UNAVAILABLE")),
      { enableHighAccuracy: false, timeout: timeoutMs, maximumAge: 0 },
    );
  });
}
