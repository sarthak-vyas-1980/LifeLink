import type { AssistantAnswer, ConversationTurn } from "@lifelink/rag";

/**
 * Deterministic emergency triage. It runs before the database, retrieval, location,
 * facility providers, and the language model, so it must stay pure and synchronous.
 */
export type EmergencyCategory =
  | "SELF_HARM" | "BREATHING" | "UNCONSCIOUS" | "CARDIAC" | "STROKE" | "SEIZURE"
  | "POISONING" | "ALLERGIC" | "BLEEDING" | "BURN" | "TRAUMA" | "GENERAL";

export interface EmergencyAssessment { category: EmergencyCategory }

// Ordered by which guidance matters most when a message describes several signs.
const emergencyPatterns: Array<[EmergencyCategory, RegExp]> = [
  ["SELF_HARM", /\b(?:kill (?:myself|himself|herself|themselves)|end (?:my|his|her|their) (?:own )?life|take (?:my|his|her|their) own life|want to die|suicidal|commit(?:ting)? suicide|(?:want|going|plan(?:ning)?|thinking (?:about|of)) (?:to )?(?:hurt(?:ing)?|harm(?:ing)?) myself|self[- ]harm(?:ing)?|(?:been|keep|started) cutting myself)\b/i],
  ["BREATHING", /\b(?:(?:isn't|is not|wasn't|was not|not|no longer|has stopped|stopped) breathing|choking|can't breathe|cannot breathe|unable to breathe|difficulty breathing|breathing is (?:very )?(?:difficult|hard)|severe breathing (?:difficulty|problems?)|struggling to breathe|trouble breathing|gasping for (?:air|breath)|turning blue|lips (?:are |have gone )?blue)\b/i],
  ["UNCONSCIOUS", /\b(?:unconscious|unresponsive|(?:i|he|she|they|someone|somebody|the patient|my (?:mother|father|mom|dad|friend|child|son|daughter|wife|husband|brother|sister|grandmother|grandfather)) (?:has |just |suddenly )?collapsed|not responding|isn't responding|is not responding|won't wake(?: up)?|will not wake|not waking|difficult to wake|hard to wake|difficulty (?:waking|awakening)|passed out and (?:is |isn't |won't |not )|fainted and (?:is |isn't |won't |not )|suspected shock|signs of shock|electric shock)\b/i],
  ["CARDIAC", /\b(?:(?:having|had|is having|think (?:i'?m|i am|he'?s|she'?s|they'?re) having) a heart attack|heart attack (?:now|right now)|cardiac arrest|no pulse|heart (?:has )?stopped|severe chest pain|crushing (?:chest )?pain|chest pressure (?:and|with) (?:sweating|breathlessness|shortness of breath)|chest (?:pain|hurts?|pressure|tightness)[\s\S]{0,60}\b(?:arm|jaw|sweat(?:ing)?|breathless|short of breath)|(?:left )?arm (?:is |went |feels )?numb[\s\S]{0,60}\bchest)\b/i],
  ["STROKE", /\b(?:stroke(?:[- ]like)? symptoms?|(?:having|had|is having) a stroke|face drooping|one[- ]sided weakness|sudden(?:ly)? (?:slurred speech|trouble speaking|(?:can't|cannot) speak clearly))\b/i],
  // Everyday descriptions of the same stroke signs ("her face is drooping", "speech became slurred").
  ["STROKE", /\b(?:face (?:is |has |was |started |began )?droop(?:s|ing|ed|y)?|(?:drooping|droopy) face|slurred speech (?:came on |started )?(?:suddenly|all of a sudden)|(?:speech|words?) (?:suddenly )?(?:became|become|is|are|got|went) slurred|(?:sudden )?(?:weakness|numbness) (?:on|in|down) one side|(?:one|left|right) side of (?:his|her|their|my|the) (?:face|body) (?:droops|is drooping|went numb|is numb|is weak))\b/i],
  ["SEIZURE", /\b(?:(?:having|had|is having) (?:a )?(?:seizures?|fits?|convulsions?)|is (?:seizing|convulsing|fitting)|seizure (?:that )?(?:won't|will not|doesn't) stop|seizure (?:lasting|for) (?:more than )?\d+ minutes?|convulsing|started (?:seizing|convulsing|shaking uncontrollably))\b/i],
  ["POISONING", /\b(?:(?:swallowed|drank|drunk|ate|ingested|consumed)\b[\s\S]{0,30}\b(?:bleach|poison|pesticide|insecticide|rat poison|kerosene|acid|detergent|phenyl|cleaner|cleaning (?:liquid|product)|battery|batteries)|took too many (?:pills|tablets|sleeping pills|medicines?)|overdos(?:e|ed|ing)|(?:has been|was|got) poisoned)\b/i],
  ["ALLERGIC", /\b(?:severe allergic reaction|anaphyla(?:xis|ctic)|throat (?:is )?(?:closing|swelling)|tongue (?:is )?swelling|face (?:and|or) (?:lips|throat) (?:are |is )?swelling)\b/i],
  ["BLEEDING", /\b(?:heavy (?:or uncontrolled )?(?:bleeding|blood loss)|uncontrolled bleeding|severe bleeding|bleeding (?:heavily|profusely|uncontrollably|badly|a lot)|bleeding (?:won't|will not|doesn't|isn't|is not) stop(?:ping)?|bleeding (?:is |has (?:become|got) )?(?:very |really )?(?:severe|heavy|uncontrollable)|bleeding\b[\s\S]{0,30}\b(?:won't|will not|doesn't|does not) stop|won't stop bleeding|can't stop (?:the )?bleeding|cannot stop (?:the )?bleeding|spurting blood|lost (?:a lot|lots|too much|a large amount|significant amounts?) of blood|significant blood loss|bled (?:a lot|heavily)|blood loss)\b/i],
  ["BURN", /\b(?:severe (?:burns?|burn)|large (?:or deep )?burn|large deep burn|chemical burn|electrical burn|burns? (?:over|covering) (?:a )?large area)\b/i],
  ["TRAUMA", /\b(?:major (?:accidents?|traumas?)|serious (?:crash|collision|accident|trauma|head injury|neck injury|spinal injury)|serious (?:head|neck|spinal) injuries?|serious head,? neck,? (?:or )?spinal injuries?|(?:bad|serious|major|terrible) (?:car |road |bike |bus )?(?:accident|crash)\b[\s\S]{0,60}\b(?:hurt|injured|bleeding|unconscious)|hit by (?:a )?(?:car|bus|truck|lorry|vehicle|train)|badly (?:hurt|injured)|seriously (?:hurt|injured)|stabbed|been shot|gunshot|fell from (?:a )?(?:roof|ladder|height|building|terrace)|deep (?:or )?(?:severe )?(?:wounds?|cuts?)|severe wounds?|wound is deep|severe deformity|limb (?:at an )?odd angle|bone (?:is )?visible|spinal injury)\b/i],
  ["GENERAL", /\b(?:new numbness|numbness after (?:the )?injury|tingling after (?:the )?injury|limb is (?:blue|cold)|cold or blue limb|embedded object)\b/i],
];

const educationalPhrasing = /\b(?:what (?:are|is) (?:the )?(?:warning )?(?:signs|symptoms)|warning signs|signs of|symptoms of|causes of|what causes|what is|what does|explain|define|definition of|how (?:do|does|can) (?:you|one|people) (?:recogni[sz]e|identify|tell|prevent)|for (?:a )?(?:story|novel|class|course|exam|project|assignment)|writing (?:a )?(?:story|novel)|hypothetically|in a fictional)\b/i;
const activePersonDescription = /\b(?:i|i'm|my|someone|somebody|a person|the patient|my friend|my child|he|she|they|we)\b[\s\S]{0,100}\b(?:is|are|has|have|had|lost|fell|bleeding|bleeds|can't|cannot|unable|unconscious|pain|injury|wound|collapsed|swallowed|took|having|want)\b/i;
const referentialFollowUp = /\b(?:it|that|the bleeding|the blood loss|he|she|they)\b[\s\S]{0,60}\b(?:worse|worsening|now|won't stop|cannot stop|can't stop|unconscious|not waking|can't breathe|cannot breathe|not breathing|collapsed)\b/i;

function matchCategory(text: string): EmergencyCategory | null {
  for (const [category, pattern] of emergencyPatterns) if (pattern.test(text)) return category;
  return null;
}

/** Classifies a possible emergency from the latest message; history is consulted only for referential follow-ups. */
export function assessEmergency(message: string, history: ConversationTurn[] = []): EmergencyAssessment | null {
  if (educationalPhrasing.test(message) && !activePersonDescription.test(message)) return null;
  const direct = matchCategory(message);
  if (direct) return { category: direct };
  if (!referentialFollowUp.test(message)) return null;
  const recentUserContext = history.filter((turn) => turn.role === "user").slice(-3).map((turn) => turn.content).join(" ");
  const inherited = matchCategory(recentUserContext);
  return inherited ? { category: inherited } : null;
}

/** Critical severity is decided deterministically before Gemini, RAG, or operational lookups. */
export function detectEmergencySeverity(message: string, history: ConversationTurn[] = []): boolean {
  return assessEmergency(message, history) !== null;
}

const callNow = "This may be life-threatening. Call emergency services now: 112 in India. If the call button doesn’t work, dial 112 manually or ask someone nearby to call.";
const closing = "Follow the emergency dispatcher’s instructions. You can search for nearby hospitals below as an additional step; do not delay calling.";

const guidance: Record<EmergencyCategory, string> = {
  SELF_HARM: "I’m really sorry you’re going through this. If you might act on these thoughts or are in danger right now, call 112. You can also call Tele-MANAS, India’s free 24-hour mental-health helpline, on 14416 or 1-800-891-4416. If you can, stay with someone you trust and move away from anything you could use to hurt yourself. You don’t have to handle this alone.",
  BREATHING: "Do not drive yourself. Keep the person sitting upright if they are conscious and loosen tight clothing. If they are choking and cannot speak or cough, give firm back blows between the shoulder blades. If they stop breathing and you are trained, start CPR while help is on the way.",
  UNCONSCIOUS: "Do not drive yourself. Check whether the person is breathing. If they are breathing, turn them onto their side so the airway stays clear. If they are not breathing normally, start CPR if you are trained, or follow the dispatcher’s CPR instructions. Do not give food or drink.",
  CARDIAC: "Do not drive yourself. Stop all activity and sit or lie down in a comfortable position. Loosen tight clothing and keep someone with you. If the person becomes unresponsive and is not breathing normally, start CPR if you are trained.",
  STROKE: "Do not drive yourself. Note the time the symptoms started and tell the emergency team, because treatment depends on timing. Keep the person still and comfortable, and do not give food, drink, or medication.",
  SEIZURE: "Do not drive yourself. Move hard or sharp objects away and cushion the head. Do not hold the person down or put anything in their mouth. When the shaking stops, turn them onto their side and stay with them.",
  POISONING: "Do not drive yourself. Do not make the person vomit unless a medical professional tells you to. Keep the container or packet to show the emergency team, and note when it was taken.",
  ALLERGIC: "Do not drive yourself. If the person has a prescribed adrenaline auto-injector, help them use it as directed. Keep them sitting up if breathing is hard, or lying down with legs raised if they feel faint.",
  BLEEDING: "Do not drive yourself. If bleeding, press firmly and continuously on the wound with clean cloth or gauze while help is arranged; if it soaks through, add more material without removing the first layer. Do not remove embedded objects or probe the wound. If safe and it will not worsen another injury, lie down, stay warm, and have someone stay with you.",
  BURN: "Do not drive yourself. Cool the burn under cool running water for about 20 minutes if it is safe. Remove jewellery or clothing near the burn unless it is stuck. Cover it loosely with clean, non-fluffy material. Do not apply ice, butter, or ointments.",
  TRAUMA: "Do not drive yourself. Keep the person still, especially if a head, neck, or back injury is possible, and do not move them unless they are in immediate danger. Press firmly on any heavy bleeding with clean cloth. Do not remove embedded objects.",
  GENERAL: "Do not drive yourself. Keep the person still and comfortable, do not give food or drink, and have someone stay with them until help arrives.",
};

export function buildEmergencyAnswer(assessment: EmergencyAssessment = { category: "GENERAL" }): AssistantAnswer {
  const selfHarm = assessment.category === "SELF_HARM";
  return {
    answer: selfHarm ? guidance.SELF_HARM : `${callNow} ${guidance[assessment.category]} ${closing}`,
    intent: "EMERGENCY", knowledgeUsed: false, liveDataUsed: false, sources: [],
    limitations: [selfHarm
      ? "This assistant cannot provide crisis counselling. Trained people at 112 or Tele-MANAS can help right now."
      : "Emergency instructions are general first aid and do not diagnose the cause or severity of the injury."],
    data: {
      emergency: { phoneNumber: "112", country: "IN", severity: "CRITICAL" },
      emergencyCategory: assessment.category,
      ...(selfHarm ? { helplines: [{ label: "Tele-MANAS", phoneNumber: "14416" }] } : {}),
    },
    status: "ANSWERED",
    suggestions: [],
  };
}
