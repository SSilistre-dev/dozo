import { requireOptionalNativeModule } from "expo-modules-core";
import { Platform } from "react-native";
import type { PhonePermission } from "./dozo-phone-calendar";
import { PhoneReadError } from "./dozo-phone-calendar";

/**
 * The phone's location, read once for a bot through the paired-device connection
 * (`dozo-phone-device.ts`). Only while the app is in use: it never asks for background access,
 * never watches, and keeps nothing; each request is one current reading. Approximate is rounded to
 * about a kilometre; precise is full accuracy only where the system granted precise location.
 */

export type PhoneLocationRequest = { precision: "approximate" | "precise" };
export type PhoneLocationValue = {
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  precise: boolean;
  at: string;
};
/** Runs `run` after `ms`; the returned function cancels it. */
export type Later = (run: () => void, ms: number) => () => void;

const FIX_TIMEOUT_MS = 10_000;
const APPROXIMATE_METERS = 1_000;

type Grant = {
  granted: boolean;
  ios?: { accuracy?: string } | null;
  android?: { accuracy?: string } | null;
};
type Reading = {
  coords: { latitude: number; longitude: number; accuracy: number | null };
  timestamp: number;
};

/** The part of `expo-location` this file uses. */
type LocationModule = {
  getForegroundPermissionsAsync(): Promise<Grant>;
  requestForegroundPermissionsAsync(): Promise<Grant>;
  getCurrentPositionAsync(options: { accuracy: number }): Promise<Reading>;
  Accuracy: { Low: number; High: number };
};

/** Whether this build has the location module; an older build hides the setting. */
export function locationAvailable(): boolean {
  return Platform.OS !== "web" && requireOptionalNativeModule("ExpoLocation") != null;
}

let loading: Promise<LocationModule | null> | undefined;

function loadLocation(): Promise<LocationModule | null> {
  if (!locationAvailable()) return Promise.resolve(null);
  loading ??= import("expo-location").then(
    (module): LocationModule => module,
    () => {
      loading = undefined;
      return null;
    },
  );
  return loading;
}

/** The system's answer while the app is in use, or null when it cannot tell. Never asks. */
async function grant(location: LocationModule): Promise<Grant | null> {
  try {
    return await location.getForegroundPermissionsAsync();
  } catch {
    return null;
  }
}

const permissionOf = (answer: Grant | null): PhonePermission =>
  !answer ? "unavailable" : answer.granted ? "granted" : "denied";

/** Whether the system lets the app read the location now. Never asks. */
export async function locationPermission(): Promise<PhonePermission> {
  const location = await loadLocation();
  return location ? permissionOf(await grant(location)) : "unavailable";
}

/** Asks the system for the location while the app is in use; never for background access. */
export async function requestLocationPermission(): Promise<PhonePermission> {
  const location = await loadLocation();
  if (!location) return "unavailable";
  try {
    return permissionOf(await location.requestForegroundPermissionsAsync());
  } catch {
    return "unavailable";
  }
}

/** Whether the user allowed precise location (iOS full accuracy, Android fine). */
const grantedPrecise = (answer: Grant) =>
  answer.ios?.accuracy === "full" || answer.android?.accuracy === "fine";

const rounded = (degrees: number) => Math.round(degrees * 100) / 100;

/** One current reading, or null when none came within the timeout. */
function currentReading(
  location: LocationModule,
  accuracy: number,
  later: Later,
): Promise<Reading | null> {
  return new Promise((resolve, reject) => {
    const cancel = later(() => resolve(null), FIX_TIMEOUT_MS);
    location.getCurrentPositionAsync({ accuracy }).then(
      (reading) => {
        cancel();
        resolve(reading);
      },
      (error: unknown) => {
        cancel();
        reject(error);
      },
    );
  });
}

/** The location, as asked and as allowed; throws `PhoneReadError` when it cannot answer. */
export async function readLocation(
  request: PhoneLocationRequest,
  later: Later,
): Promise<PhoneLocationValue> {
  const location = await loadLocation();
  if (!location) throw new PhoneReadError("location-unavailable");
  const answer = await grant(location);
  if (!answer) throw new PhoneReadError("location-unavailable");
  if (!answer.granted) throw new PhoneReadError("location-permission");
  const precise = request.precision === "precise" && grantedPrecise(answer);
  let reading: Reading | null;
  try {
    reading = await currentReading(
      location,
      precise ? location.Accuracy.High : location.Accuracy.Low,
      later,
    );
  } catch {
    reading = null;
  }
  const at = new Date(reading?.timestamp ?? Number.NaN);
  if (
    !reading ||
    Number.isNaN(at.getTime()) ||
    !Number.isFinite(reading.coords.latitude) ||
    !Number.isFinite(reading.coords.longitude)
  ) {
    throw new PhoneReadError("location-unavailable");
  }
  const { latitude, longitude, accuracy } = reading.coords;
  const meters =
    typeof accuracy === "number" && Number.isFinite(accuracy) ? Math.ceil(accuracy) : null;
  if (precise && meters !== null) {
    return { latitude, longitude, accuracyMeters: meters, precise: true, at: at.toISOString() };
  }
  return {
    latitude: rounded(latitude),
    longitude: rounded(longitude),
    accuracyMeters: Math.max(APPROXIMATE_METERS, meters ?? APPROXIMATE_METERS),
    precise: false,
    at: at.toISOString(),
  };
}
