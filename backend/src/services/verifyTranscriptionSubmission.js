"use strict";

function normalize(value) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function paragraphs(value) {
  return normalize(value)
    .split(/\n\s*\n/)
    .map(part => part.trim())
    .filter(Boolean);
}

function speakerLabels(value) {
  return normalize(value).match(
    /^\s*(?:Speaker\s+\d+|[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}):/gm
  ) || [];
}

function timestamps(value) {
  return normalize(value).match(
    /(?:\[\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?\]|\b\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?\b)/g
  ) || [];
}

function structuralSections(value) {
  const aliases = {
    title: "title",
    date: "date",
    speaker: "speaker",
    speakers: "speaker",
    "prepared by": "prepared_by",
    footer: "footer",
    agenda: "agenda",
    minutes: "minutes",
    attendees: "participants",
    participant: "participants",
    participants: "participants",
    present: "participants"
  };

  const found = [];
  const pattern = /^\s*(title|date|speakers?|prepared by|footer|agenda|minutes|attendees|participants?|present):/gim;
  let match;

  while ((match = pattern.exec(normalize(value)))) {
    found.push(aliases[match[1].toLowerCase()]);
  }

  return found;
}

function terminalPunctuationCount(value) {
  return (normalize(value).match(/[.!?](?:["')\]]*)?(?=\s|$)/g) || []).length;
}

function balanced(text, open, close) {
  let depth = 0;

  for (const char of text) {
    if (char === open) depth += 1;
    if (char === close) depth -= 1;
    if (depth < 0) return false;
  }

  return depth === 0;
}

function verifyTranscriptionSubmission({
  referenceTranscript,
  transcriptText,
  requiredTranscript = ""
}) {
  const reference = normalize(referenceTranscript);
  const submitted = normalize(transcriptText);
  const requirements = normalize(requiredTranscript).toLowerCase();
  const checks = [];

  const add = (check, passed, message) => {
    checks.push({ check, passed: Boolean(passed), message });
  };

  add(
    "transcript_content",
    Boolean(reference && submitted),
    reference && submitted
      ? "Reference and submitted transcript are present."
      : "A reference transcript and submitted transcript are required."
  );

  if (!reference || !submitted) {
    return { passed: false, checks };
  }

  const refParagraphs = paragraphs(reference);
  const subParagraphs = paragraphs(submitted);

  const paragraphRequired = refParagraphs.length >= 2;
  add(
    "paragraph_structure",
    !paragraphRequired || subParagraphs.length >= 2,
    !paragraphRequired || subParagraphs.length >= 2
      ? "Paragraph separation is present where required."
      : "The reference uses multiple paragraphs, but the submission is one continuous block."
  );

  const refSpeakers = speakerLabels(reference);
  const subSpeakers = speakerLabels(submitted);
  const speakerRequired =
    /\bspeaker\s+labels?\b/i.test(requirements) ||
    refSpeakers.length > 0;

  const refSpeakerNames = refSpeakers.map(label =>
    label.replace(/^\s*/, "").replace(/:$/, "").toLowerCase()
  );
  const subSpeakerNames = subSpeakers.map(label =>
    label.replace(/^\s*/, "").replace(/:$/, "").toLowerCase()
  );

  const speakerLabelsPresent = !speakerRequired ||
    (
      subSpeakerNames.length > 0 &&
      (
        refSpeakerNames.length === 0 ||
        refSpeakerNames.some(label => subSpeakerNames.includes(label))
      )
    );

  add(
    "speaker_labels",
    speakerLabelsPresent,
    speakerLabelsPresent
      ? "Speaker-label formatting is present where required."
      : "Required speaker labels are missing or do not match the reference label format."
  );

  const refTimes = timestamps(reference);
  const subTimes = timestamps(submitted);
  const timestampsRequired =
    /\b(timestamp|timestamps|timecode|timecodes|srt|vtt|captions)\b/i.test(requirements) ||
    refTimes.length > 0;

  add(
    "timestamp_structure",
    !timestampsRequired || subTimes.length > 0,
    !timestampsRequired || subTimes.length > 0
      ? "Timestamp formatting is present where required."
      : "The reference or job requirements use timestamps, but none were found in the submission."
  );

  const refSections = structuralSections(reference);
  const subSections = structuralSections(submitted);
  const missingSections = [...new Set(refSections)].filter(
    section => !subSections.includes(section)
  );

  add(
    "headings_and_sections",
    missingSections.length === 0,
    missingSections.length === 0
      ? "Recognized headings and equivalent section labels are preserved."
      : "Missing structural sections: " + missingSections.join(", ") + "."
  );

  const refPunctuation = terminalPunctuationCount(reference);
  const subPunctuation = terminalPunctuationCount(submitted);
  const punctuationRequired = refPunctuation >= 4;
  const minimumPunctuation = Math.max(1, Math.ceil(refPunctuation * 0.5));

  add(
    "punctuation",
    !punctuationRequired || subPunctuation >= minimumPunctuation,
    !punctuationRequired || subPunctuation >= minimumPunctuation
      ? "Sentence punctuation is reasonably consistent with the reference."
      : `The reference has ${refPunctuation} sentence endings, but the submission has only ${subPunctuation}.`
  );

  const bracketsBalanced =
    balanced(submitted, "(", ")") &&
    balanced(submitted, "[", "]") &&
    balanced(submitted, "{", "}");

  add(
    "balanced_brackets",
    bracketsBalanced,
    bracketsBalanced
      ? "Brackets and parentheses are balanced."
      : "The submission contains unbalanced brackets or parentheses."
  );

  return {
    passed: checks.every(item => item.passed),
    checks
  };
}

module.exports = verifyTranscriptionSubmission;
