/**
 * Last-resort check used only when the assistant API cannot be reached. The server's
 * deterministic triage is authoritative; this narrower list keeps the 112 action visible
 * for the clearest emergency descriptions even when the network or server is down.
 */
const OFFLINE_EMERGENCY = /\b(?:not breathing|stopped breathing|can't breathe|cannot breathe|choking|unconscious|unresponsive|collapsed|heart attack|cardiac arrest|seizure|convulsing|stroke|face (?:is )?drooping|overdos(?:e|ed)|swallowed (?:bleach|poison|pesticide|acid|kerosene)|bleeding (?:heavily|badly|won't stop|will not stop)|heavy bleeding|severe bleeding|severe burn|kill myself|suicid(?:e|al)|end my life)\b/i;
const EDUCATIONAL = /\b(?:what (?:is|are|causes)|signs of|symptoms of|explain|define)\b/i;

export function looksLikeEmergencyOffline(message: string): boolean {
  return OFFLINE_EMERGENCY.test(message) && !(EDUCATIONAL.test(message) && !/\b(?:i|my|he|she|they|someone)\b/i.test(message));
}
