"use strict";

const FORMATS = ["plain", "cornell", "charting", "outline", "qa", "comparison"];

function text(value, label, required = true) {
  if (value === undefined || value === null) value = "";

  if (typeof value !== "string") {
    throw new Error(`${label} must be text.`);
  }

  const result = value.trim();

  if (required && !result) {
    throw new Error(`${label} is required.`);
  }

  if (result.length > 20000) {
    throw new Error(`${label} cannot exceed 20,000 characters.`);
  }

  return result;
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }

  return value;
}

function array(value, label, min, max) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new Error(`${label} must contain between ${min} and ${max} items.`);
  }

  return value;
}

function normalizeNotesSubmission(body = {}) {
  const format = body.format === undefined ? "plain" : body.format;

  if (!FORMATS.includes(format)) {
    throw new Error("Choose a valid notes format.");
  }

  if (format === "plain") {
    const notesText = text(body.notesText, "Notes");

    if (notesText.length > 200000) {
      throw new Error("Notes cannot exceed 200,000 characters.");
    }

    return { format, sections: {}, notesText };
  }

  const source = object(body.sections, "Submission sections");
  let sections;
  let notesText;

  if (format === "cornell") {
    sections = {
      cues: text(source.cues, "Cornell cues"),
      notes: text(source.notes, "Cornell notes"),
      summary: text(source.summary, "Cornell summary")
    };

    notesText = [
      "CUES / QUESTIONS",
      sections.cues,
      "",
      "DETAILED NOTES",
      sections.notes,
      "",
      "SUMMARY",
      sections.summary
    ].join("\n");
  }

  if (format === "charting") {
    sections = {
      columns: array(source.columns, "Charting columns", 2, 30).map((item, i) => {
        object(item, `Column ${i + 1}`);

        return {
          heading: text(item.heading, `Column ${i + 1} heading`),
          content: text(item.content, `Column ${i + 1} content`)
        };
      })
    };

    notesText = sections.columns.map(item =>
      `${item.heading}\n${item.content}`
    ).join("\n\n");
  }

  if (format === "outline") {
    sections = {
      items: array(source.items, "Outline topics", 1, 50).map((item, i) => {
        object(item, `Topic ${i + 1}`);

        const subtopics = item.subtopics === undefined
          ? []
          : array(item.subtopics, `Topic ${i + 1} subtopics`, 0, 30);

        return {
          heading: text(item.heading, `Topic ${i + 1} heading`),
          details: text(item.details, `Topic ${i + 1} details`, false),
          subtopics: subtopics.map((sub, j) => {
            object(sub, `Subtopic ${j + 1}`);

            return {
              heading: text(sub.heading, `Subtopic ${j + 1} heading`),
              details: text(sub.details, `Subtopic ${j + 1} details`, false)
            };
          })
        };
      })
    };

    notesText = sections.items.map(item => [
      item.heading,
      item.details,
      ...item.subtopics.map(sub => `  ${sub.heading}\n  ${sub.details}`)
    ].filter(Boolean).join("\n")).join("\n\n");
  }

  if (format === "qa") {
    sections = {
      items: array(source.items, "Q&A items", 1, 100).map((item, i) => {
        object(item, `Q&A item ${i + 1}`);

        return {
          question: text(item.question, `Question ${i + 1}`),
          answer: text(item.answer, `Answer ${i + 1}`),
          explanation: text(item.explanation, `Explanation ${i + 1}`, false)
        };
      })
    };

    notesText = sections.items.map((item, i) => [
      `QUESTION ${i + 1}`,
      item.question,
      "ANSWER",
      item.answer,
      item.explanation ? `EXPLANATION\n${item.explanation}` : ""
    ].filter(Boolean).join("\n")).join("\n\n");
  }

  if (format === "comparison") {
    sections = {
      leftLabel: text(source.leftLabel, "First subject"),
      leftContent: text(source.leftContent, "First subject details"),
      rightLabel: text(source.rightLabel, "Second subject"),
      rightContent: text(source.rightContent, "Second subject details"),
      similarities: text(source.similarities, "Similarities"),
      differences: text(source.differences, "Differences")
    };

    notesText = [
      `${sections.leftLabel}\n${sections.leftContent}`,
      `${sections.rightLabel}\n${sections.rightContent}`,
      `SIMILARITIES\n${sections.similarities}`,
      `DIFFERENCES\n${sections.differences}`
    ].join("\n\n");
  }

  if (!notesText || notesText.length > 200000) {
    throw new Error("The completed notes cannot exceed 200,000 characters.");
  }

  return { format, sections, notesText };
}

module.exports = {
  FORMATS,
  normalizeNotesSubmission
};
