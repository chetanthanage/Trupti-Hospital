/* =========================================================================
   templates/appointmentTemplates.js — WhatsApp message generators.

   These match the "templates" Firestore collection conceptually (Appointment
   Confirmation / Reminder / Cancellation / Rescheduled / Doctor Reminder).
   They are kept here as plain functions — identical wording/behaviour to the
   original app — so nothing in the UI changes. If a future Settings screen
   lets staff edit template text, wire it to read from the `templates`
   Firestore collection (see js/firestore.js -> getTemplate/setTemplate) and
   fall back to these defaults.
   ========================================================================= */

import { formatDateInputValue, formatTime12h, weekdayName, dateOffset, currentGreeting, greetingEmoji, clockEmojiFor } from '../utils/helpers.js';

export const DOCTOR_NUMBER = '919370203674';
export const CLINIC_LOCATION_URL = 'https://maps.app.goo.gl/9QFgEV1qnKZRDiTPA';
export const DOCTOR_NAME = 'Dr. Rohini K. Patole';

/* ---------- SHARED SIGN-OFF ---------- */
const REACTION_REQUEST = `If you have seen the msg., please give a reaction.`;
const SIGNATURE =
  `With regards,\n` +
  `Chetan Thanage(Reception Desk)\n` +
  `Trupti Psychologycal Counselling Centre, Nashik`;

/* ---------- PATIENT CONFIRMATION MESSAGE (used by the "Send WhatsApp" action) ---------- */
export function generateAppointmentMessage(appt) {
  return (
    `🏥 Appointment Confirmation\n\n` +
    `Dear ${appt.title} ${appt.name},\n\n` +
    `We are pleased to inform you that your appointment has been scheduled.\n\n` +
    `👨‍⚕️ Doctor: ${DOCTOR_NAME}\n` +
    `🗓️ Date: ${formatDateInputValue(appt.date)}\n` +
    `⏰ Time: ${formatTime12h(appt.time)}\n` +
    `📍 Clinic Location:\n${CLINIC_LOCATION_URL}\n\n` +
    `Kindly arrive 5 minutes before your scheduled appointment.\n\n` +
    `If available, please carry any previous prescriptions, medical reports, or relevant documents.\n\n` +
    `We look forward to assisting you.\n\n` +
    `${REACTION_REQUEST}\n\n` +
    `Thank you.\n\n` +
    `${SIGNATURE}`
  );
}

/* ---------- PATIENT REMINDER MESSAGE (separate from Confirmation, used by "Send Reminder" popup) ---------- */
export function generatePatientReminderMessage(appt) {
  return (
    `⏰ Appointment Reminder\n\n` +
    `Dear ${appt.title} ${appt.name},\n\n` +
    `This is a gentle reminder of your upcoming appointment.\n\n` +
    `👨‍⚕️ Doctor: ${DOCTOR_NAME}\n` +
    `🗓️ Date: ${formatDateInputValue(appt.date)}\n` +
    `⏰ Time: ${formatTime12h(appt.time)}\n` +
    `📍 Clinic Location:\n${CLINIC_LOCATION_URL}\n\n` +
    `Kindly arrive 5 minutes before your scheduled appointment.\n\n` +
    `If available, please carry any previous prescriptions, medical reports, or relevant documents.\n\n` +
    `We look forward to seeing you.\n\n` +
    `${REACTION_REQUEST}\n\n` +
    `Thank you.\n\n` +
    `${SIGNATURE}`
  );
}

/* ---------- CANCELLATION MESSAGE ---------- */
export function generateCancellationMessage(appt, reason) {
  return (
    `🏥 Appointment Cancellation\n\n` +
    `Dear ${appt.title} ${appt.name},\n\n` +
    `We regret to inform you that your counselling appointment with ${DOCTOR_NAME} scheduled for:\n\n` +
    `📅 Date: ${formatDateInputValue(appt.date)}\n` +
    `🕒 Time: ${formatTime12h(appt.time)}\n\n` +
    `has been cancelled.\n\n` +
    `Reason:\n${reason}\n\n` +
    `We sincerely apologise for any inconvenience caused.\n\n` +
    `If you would like to book another appointment, please reply to this message or contact us. We will be happy to assist you with a new appointment.\n\n` +
    `Thank you for your understanding and cooperation.\n\n` +
    `${REACTION_REQUEST}\n\n` +
    `${SIGNATURE}`
  );
}

/* ---------- RESCHEDULE MESSAGE ---------- */
export function generateRescheduleMessage(appt, oldDate, oldTime, newDate, newTime) {
  return (
    `🏥 Appointment Rescheduled\n\n` +
    `Dear ${appt.title} ${appt.name},\n\n` +
    `Your counselling appointment with ${DOCTOR_NAME} has been rescheduled.\n\n` +
    `Previous Appointment\n\n` +
    `📅 ${formatDateInputValue(oldDate)}\n` +
    `🕒 ${formatTime12h(oldTime)}\n\n` +
    `New Appointment\n\n` +
    `📅 ${formatDateInputValue(newDate)}\n` +
    `🕒 ${formatTime12h(newTime)}\n\n` +
    `📍 Clinic Location:\n${CLINIC_LOCATION_URL}\n\n` +
    `Kindly arrive 5 minutes before your scheduled appointment.\n\n` +
    `Thank you for your understanding and cooperation.\n\n` +
    `We look forward to seeing you.\n\n` +
    `${REACTION_REQUEST}\n\n` +
    `${SIGNATURE}`
  );
}

function buildAppointmentLines(list) {
  return list.map((a) => `${clockEmojiFor(a.time)} ${formatTime12h(a.time)} - ${a.name} (${a.mobile})`).join('\n');
}

/* ---------- DOCTOR REMINDER MESSAGE ---------- */
export function generateReminderMessage(todayList, tomorrowList) {
  const greeting = currentGreeting();
  const emoji = greetingEmoji(greeting);
  const hasToday = todayList.length > 0;
  const hasTomorrow = tomorrowList.length > 0;

  let body = `${greeting} Ma'am ${emoji}\n\n`;
  body += `Just a gentle reminder that we have the following counselling appointments scheduled:\n`;

  if (hasToday) {
    body += `\n🗓️ Today (${weekdayName(dateOffset(0))})\n\n`;
    body += buildAppointmentLines(todayList);
    body += `\n`;
  }
  if (hasTomorrow) {
    body += `\n🗓️ Tomorrow (${weekdayName(dateOffset(1))})\n\n`;
    body += buildAppointmentLines(tomorrowList);
    body += `\n`;
  }
  if (!hasToday && !hasTomorrow) {
    body += `\nThere are no appointments scheduled for today or tomorrow yet.\n`;
  }

  body += `\nIf you’d like any changes, please let me know, and I’ll be happy to make them.\n\n`;
  body += `Thank you, Ma'am.\nHave a wonderful day! 😊`;

  return body;
}
