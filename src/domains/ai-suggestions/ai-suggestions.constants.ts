export const AI_SUGGESTIONS_CONSTANTS = {
  // Minimum number of translated verses required before AI suggestions are enabled for a project unit
  ACTIVATION_THRESHOLD_VERSES: 500,

  // Number of verses to automatically queue when a drafter is first assigned a chapter
  INITIAL_QUEUE_COUNT: 3,

  // Default number of verses to pre-fetch ahead of the drafter's current verse
  DEFAULT_LOOKAHEAD: 5,
} as const;
