// Pure XML-parsing logic for uploaded survey files. No Express/DB/S3 imports
// here — this module only knows how to turn a raw Buffer into
// [{ order_index, question_text, points, answers }] or throw a
// SurveyXmlError.
//
// Two <question> shapes are accepted:
//   1. Flat: <question points="10">text</question> — the question is
//      itself the single scored item. `answers` is [] for these.
//   2. Nested: <question>prompt text<answer points="10" category="Music">
//      answer text</answer>...</question> — one DAY of the survey.
// Both shapes can appear in the same survey.
//
// The nested shape is a RATING scale, not a multiple choice. Its
// <question> text is a shared PREFIX rather than a standalone question,
// and each <answer> is a separate rateable STATEMENT — prefix + statement
// together form the real question. Given:
//
//   <question>I really enjoyed…
//     <answer points="10" category="Music">Learning about the parts of the violin</answer>
//     <answer points="10" category="Music">Learning some rhythm and notes</answer>
//   </question>
//
// the student is asked "I really enjoyed *learning about the parts of the
// violin*" and rates it 1-10, then likewise for every other statement —
// they answer all of them, they do not pick one. An <answer>'s `points` is
// therefore the MAXIMUM of that statement's 1..N rating scale (so
// points="5" would mean a 1-5 scale), never a value earned by selecting
// that line. Because "answer" here means "rateable statement", each one
// produces its own survey_responses row at submit time (see
// migrations/0014_survey_responses_per_answer.sql).
//
// `points` on the returned question is the SUM of its answers' points
// (there is no points attribute on a nested <question> itself) — i.e. that
// day's maximum achievable score, 50 for five 1-10 statements.
//
// Validation below is plain imperative JS, deliberately not zod. An earlier
// version used z.union([...]).transform(...) for <question>/<answer>, but
// zod only runs a union's .transform() (where the friendly per-field
// messages live) *after* the input already structurally matches one of the
// union's branches. Any shape that matches none of them (e.g. an <answer>
// missing its required points attribute entirely) fails at the union step
// itself, before the transform ever runs, and zod reports its own generic
// "Invalid input" instead of any message this file defines. That generic
// text then leaks straight to the uploader with no indication of what's
// actually wrong. Hand-rolled validation here means every failure path
// always goes through one of the explicit messages below — there is no
// generic fallback for a shape mismatch to fall into.
//
// Security note: survey XML is untrusted user input, so this module treats
// it as hostile by default:
//   1. A pre-parse substring check rejects anything that looks like a
//      DOCTYPE or ENTITY declaration before the parser ever sees it.
//   2. fast-xml-parser is additionally configured with processEntities:
//      false and ignoreDeclaration: true, so even if step 1 were somehow
//      bypassed, entity expansion never happens.
// Both layers exist deliberately (defense in depth) — do not remove either
// one because the other "already handles it".

const { XMLParser } = require('fast-xml-parser');

const MAX_QUESTIONS = 200;
const MAX_ANSWERS_PER_QUESTION = 50;
const MAX_QUESTION_TEXT_LENGTH = 2000;
const MAX_CATEGORY_LENGTH = 100;

const DANGEROUS_MARKUP_REGEX = /<!DOCTYPE|<!ENTITY/i;

class SurveyXmlError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SurveyXmlError';
  }
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  textNodeName: '#text',
  isArray: (name) => name === 'question' || name === 'answer',
  processEntities: false,
  ignoreDeclaration: true
});

function isPlainTextNode(value) {
  return typeof value === 'string' || typeof value === 'number';
}

function isElementNode(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Validates one <answer> node. Returns { ok: true, answer } or
// { ok: false, message }.
function validateAnswer(value) {
  if (!isPlainTextNode(value) && !isElementNode(value)) {
    return { ok: false, message: 'Each answer must be text or an element with a points attribute' };
  }

  const isPlain = isPlainTextNode(value);
  const rawPoints = isPlain ? undefined : value.points;
  const rawText = isPlain ? value : value['#text'];
  const rawCategory = isPlain ? undefined : value.category;

  if (rawPoints === undefined) {
    return { ok: false, message: 'Each answer must have a points attribute' };
  }

  const points = Number(rawPoints);
  if (!Number.isInteger(points) || points < 0 || points > 1000) {
    return { ok: false, message: 'answer points must be an integer between 0 and 1000' };
  }

  const text = String(rawText ?? '').trim();
  if (text.length === 0) {
    return { ok: false, message: 'Each answer must have non-empty text content' };
  }
  if (text.length > MAX_QUESTION_TEXT_LENGTH) {
    return { ok: false, message: `answer text must be at most ${MAX_QUESTION_TEXT_LENGTH} characters` };
  }

  const category = rawCategory === undefined ? null : String(rawCategory).trim().slice(0, MAX_CATEGORY_LENGTH) || null;

  return { ok: true, answer: { answer_text: text, points, category } };
}

// Validates one <question> node (flat or nested). Returns
// { ok: true, question } or { ok: false, message }.
function validateQuestion(value) {
  if (!isPlainTextNode(value) && !isElementNode(value)) {
    return { ok: false, message: 'Each question must be text or an element with a points attribute or answer children' };
  }

  if (isElementNode(value) && Array.isArray(value.answer)) {
    if (value.answer.length === 0) {
      return { ok: false, message: 'A question with answers must contain at least one answer' };
    }
    if (value.answer.length > MAX_ANSWERS_PER_QUESTION) {
      return { ok: false, message: `A question must contain at most ${MAX_ANSWERS_PER_QUESTION} answers` };
    }

    const answers = [];
    for (const rawAnswer of value.answer) {
      const result = validateAnswer(rawAnswer);
      if (!result.ok) {
        return result;
      }
      answers.push(result.answer);
    }

    const text = String(value['#text'] ?? '').trim();
    if (text.length === 0) {
      return { ok: false, message: 'A question with answers must have non-empty prompt text' };
    }
    if (text.length > MAX_QUESTION_TEXT_LENGTH) {
      return { ok: false, message: `question text must be at most ${MAX_QUESTION_TEXT_LENGTH} characters` };
    }

    const points = answers.reduce((sum, answer) => sum + answer.points, 0);
    return { ok: true, question: { question_text: text, points, answers } };
  }

  const isPlain = isPlainTextNode(value);
  const rawPoints = isPlain ? undefined : value.points;
  const rawText = isPlain ? value : value['#text'];

  if (rawPoints === undefined) {
    return { ok: false, message: 'Each question must have a points attribute' };
  }

  const points = Number(rawPoints);
  if (!Number.isInteger(points) || points < 0 || points > 1000) {
    return { ok: false, message: 'question points must be an integer between 0 and 1000' };
  }

  const text = String(rawText ?? '').trim();
  if (text.length === 0) {
    return { ok: false, message: 'Each question must have non-empty text content' };
  }
  if (text.length > MAX_QUESTION_TEXT_LENGTH) {
    return { ok: false, message: `question text must be at most ${MAX_QUESTION_TEXT_LENGTH} characters` };
  }

  return { ok: true, question: { question_text: text, points, answers: [] } };
}

function parseSurveyXml(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new SurveyXmlError('Survey file must be provided as a buffer');
  }

  const raw = buffer.toString('utf8');

  if (DANGEROUS_MARKUP_REGEX.test(raw)) {
    throw new SurveyXmlError('Survey XML must not contain DOCTYPE or ENTITY declarations');
  }

  let parsed;
  try {
    parsed = parser.parse(raw, true);
  } catch (err) {
    throw new SurveyXmlError(`Survey XML is not well-formed: ${err.message}`);
  }

  if (typeof parsed !== 'object' || parsed === null || typeof parsed.survey !== 'object' || parsed.survey === null) {
    throw new SurveyXmlError('Survey XML root element must be <survey>');
  }

  const rawQuestions = parsed.survey.question;
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
    throw new SurveyXmlError('Survey must contain at least one question');
  }
  if (rawQuestions.length > MAX_QUESTIONS) {
    throw new SurveyXmlError(`Survey must contain at most ${MAX_QUESTIONS} questions`);
  }

  const questions = [];
  for (let index = 0; index < rawQuestions.length; index += 1) {
    const result = validateQuestion(rawQuestions[index]);
    if (!result.ok) {
      throw new SurveyXmlError(result.message);
    }
    questions.push({
      order_index: index,
      question_text: result.question.question_text,
      points: result.question.points,
      answers: result.question.answers
    });
  }

  return questions;
}

module.exports = { parseSurveyXml, SurveyXmlError };
