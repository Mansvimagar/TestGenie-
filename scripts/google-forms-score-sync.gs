/**
 * Installable on-form-submit trigger for a Google Form created by TestGenie.
 * Set these Script Properties on the form's Apps Script project:
 *   TESTGENIE_SCORE_WEBHOOK_URL = https://<app-host>/api/scores/ingest
 *   TESTGENIE_SCORE_WEBHOOK_SECRET = same value as server-only env secret
 *
 * The app deduplicates by (test, Google response ID), so trigger retries are safe.
 */
const IDENTITY_TITLES = ["Full Name", "Roll No", "Class", "Division"];

function onTestGenieFormSubmit(event) {
  if (!event || !event.response || !event.source) {
    throw new Error("Install this as a Google Forms on-form-submit trigger.");
  }

  const properties = PropertiesService.getScriptProperties();
  const webhookUrl = properties.getProperty("TESTGENIE_SCORE_WEBHOOK_URL");
  const secret = properties.getProperty("TESTGENIE_SCORE_WEBHOOK_SECRET");
  if (!webhookUrl || !secret) {
    throw new Error("Set the TestGenie score webhook URL and secret in Script Properties.");
  }

  const response = event.response;
  // Identity items ("Full Name", "Roll No", "Class", "Division") are ungraded and
  // are read by title; only the remaining items count towards the score.
  const identity = {};
  response.getItemResponses().forEach((itemResponse) => {
    const title = itemResponse.getItem().getTitle();
    if (IDENTITY_TITLES.indexOf(title) !== -1) identity[title] = String(itemResponse.getResponse() || "").trim();
  });
  const gradedResponses = response.getGradableItemResponses().filter(
    (itemResponse) => IDENTITY_TITLES.indexOf(itemResponse.getItem().getTitle()) === -1
  );
  const itemScores = gradedResponses.map((itemResponse) => itemResponse.getScore());
  if (itemScores.length === 0 || itemScores.some((value) => typeof value !== "number")) {
    throw new Error("Google Forms did not provide a graded score for this response.");
  }

  const email = response.getRespondentEmail() || "";
  const payload = {
    formId: event.source.getId(),
    responseId: response.getId(),
    studentName: identity["Full Name"] || email || "Google Forms respondent",
    studentEmail: email,
    studentRollNo: identity["Roll No"] || "",
    studentClass: identity["Class"] || "",
    studentDivision: identity["Division"] || "",
    score: itemScores.reduce((total, value) => total + value, 0),
    totalQuestions: itemScores.length,
    submittedAt: response.getTimestamp().toISOString(),
  };

  const result = UrlFetchApp.fetch(webhookUrl, {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: `Bearer ${secret}` },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  if (result.getResponseCode() < 200 || result.getResponseCode() >= 300) {
    throw new Error(`TestGenie rejected score ingestion (HTTP ${result.getResponseCode()}).`);
  }
}
