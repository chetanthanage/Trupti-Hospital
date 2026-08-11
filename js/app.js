/* =========================================================================
   js/app.js — Clinic WhatsApp Assistant application logic.

   ARCHITECTURE NOTE:
   The Calendar is the single source of truth for appointment data. All
   other views (Doctor Reminder, All Appointments) read from the same
   DataStore module (js/firestore.js) — nothing is entered twice. DataStore
   is a real-time, Firestore-backed cache exposing the exact same
   synchronous-looking API the app always used (getAll/getById/getByDate/
   query/add/update/replace/remove), so none of the rendering or event-
   handling code below had to change when Local Storage was replaced with
   Cloud Firestore — see js/firestore.js for how that works.
   ========================================================================= */

import { DataStore, setErrorHandler, logActivity } from './firestore.js';
import { requireAuth, signOutUser } from './auth.js';
import {
  pad, dateOffset, isoDate, parseISODate, weekdayName, formatFullDate,
  currentGreeting, greetingEmoji, formatTime12h, clockEmojiFor,
  formatDateInputValue, escapeForWhatsApp, escapeHtml, initialsFor, currentTimeLabel,
  onlyDigits
} from '../utils/helpers.js';
import { isValidMobile } from '../utils/validators.js';
import {
  DOCTOR_NUMBER,
  generateAppointmentMessage, generateCancellationMessage,
  generateRescheduleMessage, generateReminderMessage
} from '../templates/appointmentTemplates.js';

  /* ======================================================================
     CONSTANTS
     ====================================================================== */

  const STORAGE_KEYS = {
    THEME: 'clinic_theme' // UI preference only — not appointment data, stays local per device.
  };

  // Appointment type -> display label + accent colour (drives chips, dots, card borders, avatars)
  const TYPE_META = {
    counselling: { label: 'Counselling', color: 'teal' },
    followup: { label: 'Follow-up', color: 'blue' },
    new: { label: 'New Patient', color: 'green' },
    review: { label: 'Review', color: 'orange' },
    cancelled: { label: 'Cancelled', color: 'red' },
    completed: { label: 'Completed', color: 'grey' }
  };

  // Lifecycle status -> display label (independent of appointment "type"/category)
  const STATUS_META = {
    scheduled: { label: 'Scheduled' },
    confirmed: { label: 'Confirmed' },
    cancelled: { label: 'Cancelled' },
    rescheduled: { label: 'Rescheduled' },
    completed: { label: 'Completed' }
  };

  /** True if a today-dated, non-cancelled/completed appointment starts within the next hour. */
  function isStartingSoon(appt) {
    if (appt.date !== isoDate(dateOffset(0))) return false;
    if (appt.type === 'cancelled' || appt.type === 'completed') return false;
    const now = new Date();
    const [h, m] = appt.time.split(':').map(Number);
    const apptMinutes = h * 60 + m;
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const diff = apptMinutes - nowMinutes;
    return diff >= 0 && diff <= 60;
  }

  /* ======================================================================
     LIVE HEADER CLOCK
     ====================================================================== */

  const headerDateEl = document.getElementById('headerDate');
  const headerTimeEl = document.getElementById('headerTime');

  function updateHeaderClock() {
    const now = new Date();
    headerDateEl.textContent = now.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    headerTimeEl.textContent = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  }

  /* ======================================================================
     TOAST
     ====================================================================== */

  const toastEl = document.getElementById('toast');
  let toastTimer = null;

  function showToast(message) {
    toastEl.textContent = message;
    toastEl.classList.add('toast--visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.classList.remove('toast--visible');
    }, 2200);
  }

  /* ======================================================================
     UNDO TOAST — shown after Cancel / Reschedule actions for 20 seconds
     ====================================================================== */

  const undoToastEl = document.getElementById('undoToast');
  const undoToastTextEl = document.getElementById('undoToastText');
  const undoToastBarEl = document.getElementById('undoToastBar');
  const undoBtn = document.getElementById('undoBtn');

  let pendingUndo = null; // { kind: 'delete' | 'replace', apptId, snapshot?, timeoutId }

  /**
   * Shows the Undo bar for 20 seconds. `kind` is 'delete' (the action created
   * a brand-new record that should simply be removed) or 'replace' (restore
   * the full previous record via DataStore.replace, avoiding stale fields).
   */
  function scheduleUndo(message, kind, apptId, snapshot) {
    if (pendingUndo && pendingUndo.timeoutId) clearTimeout(pendingUndo.timeoutId);

    undoToastTextEl.textContent = message;
    undoToastEl.hidden = false;
    // Restart the countdown-bar animation.
    undoToastBarEl.classList.remove('undo-toast__bar--running');
    void undoToastBarEl.offsetWidth; // force reflow so the animation restarts
    undoToastBarEl.classList.add('undo-toast__bar--running');

    requestAnimationFrame(() => undoToastEl.classList.add('undo-toast--visible'));

    pendingUndo = { kind, apptId, snapshot };
    pendingUndo.timeoutId = setTimeout(hideUndoToast, 20000);
  }

  function hideUndoToast() {
    undoToastEl.classList.remove('undo-toast--visible');
    setTimeout(() => { undoToastEl.hidden = true; }, 220);
    pendingUndo = null;
  }

  undoBtn.addEventListener('click', () => {
    if (!pendingUndo) return;
    clearTimeout(pendingUndo.timeoutId);
    const { kind, apptId, snapshot } = pendingUndo;

    if (kind === 'delete') {
      DataStore.remove(apptId);
    } else if (kind === 'replace' && snapshot) {
      DataStore.replace(apptId, snapshot);
    }

    pendingUndo = null;
    hideUndoToast();
    refreshEverything();
    if (!dayModalOverlay.hidden) renderDayModalList();
    showToast('Action undone.');
  });

  /* ======================================================================
     CLIPBOARD
     ====================================================================== */

  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        () => showToast('Message copied to clipboard ✅'),
        () => fallbackCopy(text)
      );
    } else {
      fallbackCopy(text);
    }
  }

  function fallbackCopy(text) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    try {
      document.execCommand('copy');
      showToast('Message copied to clipboard ✅');
    } catch (e) {
      showToast('Could not copy automatically. Please select and copy manually.');
    }
    document.body.removeChild(textarea);
  }

  /* ======================================================================
     LOADING OVERLAY + WHATSAPP LAUNCH
     ====================================================================== */

  const loadingOverlay = document.getElementById('loadingOverlay');

  function openWhatsApp(number, message) {
    loadingOverlay.hidden = false;
    const url = `https://wa.me/${number}?text=${escapeForWhatsApp(message)}`;
    setTimeout(() => {
      window.open(url, '_blank');
      loadingOverlay.hidden = true;
    }, 700);
  }

  /* ======================================================================
     TABS
     ====================================================================== */

  const tabBtnCalendar = document.getElementById('tabBtnCalendar');
  const tabBtnReminder = document.getElementById('tabBtnReminder');
  const tabBtnAll = document.getElementById('tabBtnAll');
  const tabBtnPatients = document.getElementById('tabBtnPatients');
  const panelCalendar = document.getElementById('panelCalendar');
  const panelReminder = document.getElementById('panelReminder');
  const panelAll = document.getElementById('panelAll');
  const panelPatients = document.getElementById('panelPatients');

  function activateTab(which) {
    const map = {
      calendar: [tabBtnCalendar, panelCalendar],
      reminder: [tabBtnReminder, panelReminder],
      all: [tabBtnAll, panelAll],
      patients: [tabBtnPatients, panelPatients]
    };
    Object.keys(map).forEach((key) => {
      const [btn, panel] = map[key];
      const active = key === which;
      btn.classList.toggle('tab--active', active);
      btn.setAttribute('aria-selected', String(active));
      panel.classList.toggle('panel--active', active);
      panel.hidden = !active;
    });
  }

  tabBtnCalendar.addEventListener('click', () => activateTab('calendar'));
  tabBtnReminder.addEventListener('click', () => activateTab('reminder'));
  tabBtnAll.addEventListener('click', () => activateTab('all'));
  tabBtnPatients.addEventListener('click', () => activateTab('patients'));

  /* ======================================================================
     THEME (DARK MODE)
     ====================================================================== */

  const themeToggle = document.getElementById('themeToggle');
  const themeToggleIcon = document.getElementById('themeToggleIcon');

  function applyTheme(theme) {
    if (theme === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
      themeToggleIcon.textContent = 'light_mode';
      themeToggle.setAttribute('aria-pressed', 'true');
    } else {
      document.documentElement.removeAttribute('data-theme');
      themeToggleIcon.textContent = 'dark_mode';
      themeToggle.setAttribute('aria-pressed', 'false');
    }
    localStorage.setItem(STORAGE_KEYS.THEME, theme);
  }

  themeToggle.addEventListener('click', () => {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    applyTheme(isDark ? 'light' : 'dark');
  });

  (function initTheme() {
    const saved = localStorage.getItem(STORAGE_KEYS.THEME);
    if (saved) {
      applyTheme(saved);
    } else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      applyTheme('dark');
    }
  })();

  /* ======================================================================
     DASHBOARD STATS — animated counters
     ====================================================================== */

  const statTodayEl = document.getElementById('statToday');
  const statTomorrowEl = document.getElementById('statTomorrow');
  const statWeekEl = document.getElementById('statWeek');
  const statMonthEl = document.getElementById('statMonth');
  const statUpcomingEl = document.getElementById('statUpcoming');

  function animateNumber(el, toValue) {
    const fromValue = parseInt(el.textContent, 10) || 0;
    if (fromValue === toValue) return;
    const duration = 420;
    const start = performance.now();

    function tick(now) {
      const progress = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      const value = Math.round(fromValue + (toValue - fromValue) * eased);
      el.textContent = value;
      if (progress < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  function computeStats() {
    const all = DataStore.getAll();
    const todayIso = isoDate(dateOffset(0));
    const tomorrowIso = isoDate(dateOffset(1));

    const todayCount = all.filter((a) => a.date === todayIso).length;
    const tomorrowCount = all.filter((a) => a.date === tomorrowIso).length;

    const today = dateOffset(0);
    const weekStart = new Date(today);
    weekStart.setDate(today.getDate() - today.getDay());
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);
    const weekStartIso = isoDate(weekStart);
    const weekEndIso = isoDate(weekEnd);
    const weekCount = all.filter((a) => a.date >= weekStartIso && a.date <= weekEndIso).length;

    const monthPrefix = `${today.getFullYear()}-${pad(today.getMonth() + 1)}`;
    const monthCount = all.filter((a) => a.date.startsWith(monthPrefix)).length;

    const nowDate = new Date();
    const upcomingEntry = all
      .filter((a) => a.type !== 'cancelled' && a.type !== 'completed')
      .map((a) => {
        const when = parseISODate(a.date);
        const [h, m] = a.time.split(':').map(Number);
        when.setHours(h, m, 0, 0);
        return { appt: a, when };
      })
      .filter((entry) => entry.when.getTime() >= nowDate.getTime())
      .sort((x, y) => x.when - y.when)[0];

    return {
      todayCount,
      tomorrowCount,
      weekCount,
      monthCount,
      upcoming: upcomingEntry ? upcomingEntry.appt : null,
      upcomingWhen: upcomingEntry ? upcomingEntry.when : null
    };
  }

  function updateStats() {
    const s = computeStats();
    animateNumber(statTodayEl, s.todayCount);
    animateNumber(statTomorrowEl, s.tomorrowCount);
    animateNumber(statWeekEl, s.weekCount);
    animateNumber(statMonthEl, s.monthCount);

    if (s.upcoming) {
      const isToday = isoDate(s.upcomingWhen) === isoDate(dateOffset(0));
      const dateLabel = isToday ? 'Today' : s.upcomingWhen.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
      const timeLabel = formatTime12h(`${pad(s.upcomingWhen.getHours())}:${pad(s.upcomingWhen.getMinutes())}`);
      statUpcomingEl.textContent = `${s.upcoming.name} · ${timeLabel} · ${dateLabel}`;
    } else {
      statUpcomingEl.textContent = 'None';
    }
  }

  /* ======================================================================
     CUSTOM TIME PICKER (Hour / Minute / AM-PM)
     Native <input type="time"> silently follows the OS locale for
     12-hour vs 24-hour display, so on many devices no AM/PM control ever
     shows up. This control always exposes an explicit AM/PM choice and
     stores the result as a 24-hour "HH:MM" string in a hidden input.
     ====================================================================== */

  function populateHourOptions(selectEl) {
    for (let h = 1; h <= 12; h++) {
      const opt = document.createElement('option');
      opt.value = String(h);
      opt.textContent = pad(h);
      selectEl.appendChild(opt);
    }
  }

  function populateMinuteOptions(selectEl) {
    for (let m = 0; m < 60; m += 5) {
      const opt = document.createElement('option');
      opt.value = String(m);
      opt.textContent = pad(m);
      selectEl.appendChild(opt);
    }
  }

  function createTimePicker({ hourEl, minuteEl, amBtn, pmBtn, hiddenEl, wrapperEl, onChange }) {
    populateHourOptions(hourEl);
    populateMinuteOptions(minuteEl);

    let meridiem = null;

    function syncHidden() {
      const h = hourEl.value;
      const m = minuteEl.value;
      if (h && m !== '' && meridiem) {
        let hour24 = parseInt(h, 10) % 12;
        if (meridiem === 'PM') hour24 += 12;
        hiddenEl.value = `${pad(hour24)}:${pad(parseInt(m, 10))}`;
      } else {
        hiddenEl.value = '';
      }
      if (typeof onChange === 'function') onChange();
    }

    function setMeridiem(value) {
      meridiem = value;
      amBtn.classList.toggle('time-picker__meridiem-btn--active', value === 'AM');
      pmBtn.classList.toggle('time-picker__meridiem-btn--active', value === 'PM');
      syncHidden();
    }

    hourEl.addEventListener('change', syncHidden);
    minuteEl.addEventListener('change', syncHidden);
    amBtn.addEventListener('click', () => setMeridiem('AM'));
    pmBtn.addEventListener('click', () => setMeridiem('PM'));

    function setValue(hhmm) {
      if (!hhmm) {
        hourEl.value = '';
        minuteEl.value = '';
        meridiem = null;
        amBtn.classList.remove('time-picker__meridiem-btn--active');
        pmBtn.classList.remove('time-picker__meridiem-btn--active');
        hiddenEl.value = '';
        return;
      }
      const [hStr, mStr] = hhmm.split(':');
      const h = parseInt(hStr, 10);
      const m = parseInt(mStr, 10);
      const mer = h >= 12 ? 'PM' : 'AM';
      let h12 = h % 12;
      if (h12 === 0) h12 = 12;

      if (!Array.from(minuteEl.options).some((o) => o.value === String(m))) {
        const opt = document.createElement('option');
        opt.value = String(m);
        opt.textContent = pad(m);
        minuteEl.appendChild(opt);
      }

      hourEl.value = String(h12);
      minuteEl.value = String(m);
      meridiem = mer;
      amBtn.classList.toggle('time-picker__meridiem-btn--active', mer === 'AM');
      pmBtn.classList.toggle('time-picker__meridiem-btn--active', mer === 'PM');
      hiddenEl.value = `${pad(h)}:${pad(m)}`;
    }

    function clear() {
      setValue('');
    }

    function setInvalid(show) {
      wrapperEl.classList.toggle('time-picker--invalid', show);
    }

    return { setValue, clear, setInvalid };
  }

  /* ======================================================================
     FIELD ERROR HELPERS
     ====================================================================== */

  function setFieldError(inputEl, errorEl, show) {
    errorEl.parentElement.classList.toggle('field--invalid', show);
    inputEl.classList.toggle('field__input--invalid', show);
  }
  function clearFieldError(inputEl, errorEl) {
    setFieldError(inputEl, errorEl, false);
  }
  /** For fields with no plain input element (e.g. the time picker). */
  function markFieldErrorVisible(errorEl, show) {
    errorEl.parentElement.classList.toggle('field--invalid', show);
  }

  /* ======================================================================
     GENERIC CONFIRM DIALOG
     ====================================================================== */

  const confirmOverlay = document.getElementById('confirmOverlay');
  const confirmMessage = document.getElementById('confirmMessage');
  const confirmCancelBtn = document.getElementById('confirmCancelBtn');
  const confirmOkBtn = document.getElementById('confirmOkBtn');
  let pendingConfirmAction = null;

  function openConfirmDialog(message, onConfirm) {
    confirmMessage.textContent = message;
    pendingConfirmAction = onConfirm;
    confirmOverlay.hidden = false;
  }
  function closeConfirmDialog() {
    confirmOverlay.hidden = true;
    pendingConfirmAction = null;
  }
  confirmCancelBtn.addEventListener('click', closeConfirmDialog);
  confirmOverlay.addEventListener('click', (e) => {
    if (e.target === confirmOverlay) closeConfirmDialog();
  });
  confirmOkBtn.addEventListener('click', () => {
    if (typeof pendingConfirmAction === 'function') pendingConfirmAction();
    closeConfirmDialog();
  });

  /* Patient confirmation / cancellation / reschedule WhatsApp message text
     now lives in templates/appointmentTemplates.js (imported at the top of
     this file) so it can double as the "templates" Firestore collection's
     default wording if a future Settings screen makes it editable. */

  /* ======================================================================
     SHARED APPOINTMENT CARD RENDERER
     Used by the Day Detail modal, Doctor Reminder lists, and All
     Appointments list, so every view stays visually and behaviourally
     consistent.
     ====================================================================== */

  function renderApptCard(appt, opts) {
    opts = opts || {};
    const meta = TYPE_META[appt.type] || TYPE_META.counselling;

    const card = document.createElement('div');
    card.className = `appt-card appt-card--${meta.color}`;
    if (isStartingSoon(appt)) card.classList.add('appt-card--soon');
    card.dataset.id = appt.id;

    const avatar = document.createElement('span');
    avatar.className = 'appt-card__avatar';
    avatar.textContent = initialsFor(appt.name);

    const info = document.createElement('div');
    info.className = 'appt-card__info';

    const nameRow = document.createElement('div');
    nameRow.className = 'appt-card__name-row';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'appt-card__name';
    nameSpan.textContent = `${appt.title} ${appt.name}`;
    nameRow.appendChild(nameSpan);

    const typeChip = document.createElement('span');
    typeChip.className = `chip chip--${meta.color}`;
    typeChip.textContent = meta.label;
    nameRow.appendChild(typeChip);

    if (appt.date === isoDate(dateOffset(0))) {
      const todayChip = document.createElement('span');
      todayChip.className = 'chip chip--today';
      todayChip.textContent = 'Today';
      nameRow.appendChild(todayChip);
    }

    info.appendChild(nameRow);

    const metaRow = document.createElement('span');
    metaRow.className = 'appt-card__meta';
    let metaHtml =
      `<span><span class="material-symbols-rounded">schedule</span>${formatTime12h(appt.time)}</span>` +
      `<span><span class="material-symbols-rounded">phone</span>${escapeHtml(appt.mobile)}</span>`;
    if (opts.showDate) {
      metaHtml += `<span><span class="material-symbols-rounded">event</span>${formatDateInputValue(appt.date)}</span>`;
    }
    metaRow.innerHTML = metaHtml;
    info.appendChild(metaRow);

    if (appt.notes) {
      const notesEl = document.createElement('span');
      notesEl.className = 'appt-card__notes';
      notesEl.textContent = '📝 ' + appt.notes;
      info.appendChild(notesEl);
    }

    const status = appt.status || 'scheduled';
    if (status === 'cancelled' && appt.cancellationReason) {
      const reasonEl = document.createElement('span');
      reasonEl.className = 'appt-card__status-note';
      reasonEl.innerHTML = '<span class="material-symbols-rounded">event_busy</span>Reason: ' + escapeHtml(appt.cancellationReason);
      info.appendChild(reasonEl);
    }
    if (status === 'rescheduled' && Array.isArray(appt.history) && appt.history.length > 0) {
      const prev = appt.history[appt.history.length - 1];
      const rescheduleEl = document.createElement('span');
      rescheduleEl.className = 'appt-card__status-note';
      rescheduleEl.innerHTML =
        '<span class="material-symbols-rounded">event_repeat</span>Rescheduled from ' +
        formatDateInputValue(prev.date) + ' · ' + formatTime12h(prev.time);
      info.appendChild(rescheduleEl);
    }

    card.appendChild(avatar);
    card.appendChild(info);

    if (opts.showActions) {
      const actions = document.createElement('div');
      actions.className = 'appt-card__actions';
      const row = document.createElement('div');
      row.className = 'appt-card__actions-row';

      const waBtn = document.createElement('button');
      waBtn.className = 'appt-card__action appt-card__action--whatsapp';
      waBtn.type = 'button';
      waBtn.setAttribute('aria-label', `Send WhatsApp message to ${appt.name}`);
      waBtn.innerHTML = '<span class="material-symbols-rounded">send</span>';
      waBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openWhatsApp(appt.mobile, generateAppointmentMessage(appt));
      });

      const rescheduleBtn = document.createElement('button');
      rescheduleBtn.className = 'appt-card__action appt-card__action--reschedule';
      rescheduleBtn.type = 'button';
      rescheduleBtn.setAttribute('aria-label', `Reschedule appointment for ${appt.name}`);
      rescheduleBtn.innerHTML = '<span class="material-symbols-rounded">event_repeat</span>';
      rescheduleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openRescheduleModal(appt);
      });

      const nextApptBtn = document.createElement('button');
      nextApptBtn.className = 'appt-card__action appt-card__action--next';
      nextApptBtn.type = 'button';
      nextApptBtn.setAttribute('aria-label', `Schedule next appointment for ${appt.name}`);
      nextApptBtn.innerHTML = '<span class="material-symbols-rounded">event_upcoming</span>';
      nextApptBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openApptModal({ mode: 'add', prefill: { name: appt.name, mobile: appt.mobile } });
      });

      const editBtn = document.createElement('button');
      editBtn.className = 'appt-card__action appt-card__action--edit';
      editBtn.type = 'button';
      editBtn.setAttribute('aria-label', `Edit appointment for ${appt.name}`);
      editBtn.innerHTML = '<span class="material-symbols-rounded">edit</span>';
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openApptModal({ mode: 'edit', appt });
      });

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'appt-card__action appt-card__action--delete';
      deleteBtn.type = 'button';
      deleteBtn.setAttribute('aria-label', `Delete appointment for ${appt.name}`);
      deleteBtn.innerHTML = '<span class="material-symbols-rounded">delete</span>';
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        confirmDeleteAppointment(appt);
      });

      row.appendChild(waBtn);
      if ((appt.status || 'scheduled') !== 'cancelled') {
        row.appendChild(rescheduleBtn);
      }
      row.appendChild(nextApptBtn);
      row.appendChild(editBtn);
      row.appendChild(deleteBtn);
      actions.appendChild(row);
      card.appendChild(actions);
    }

    return card;
  }

  function confirmDeleteAppointment(appt) {
    openConfirmDialog(`Delete the appointment for "${appt.name}"? This cannot be undone.`, () => {
      DataStore.remove(appt.id);
      logActivity('Appointment Deleted', appt.id);
      refreshEverything();
      if (!dayModalOverlay.hidden) renderDayModalList();
      showToast('Appointment deleted.');
    });
  }

  /* ======================================================================
     CALENDAR TAB
     ====================================================================== */

  const calendarTitleEl = document.getElementById('calendarTitle');
  const calendarWeekdaysEl = document.getElementById('calendarWeekdays');
  const calendarGridEl = document.getElementById('calendarGrid');
  const calPrevBtn = document.getElementById('calPrevBtn');
  const calNextBtn = document.getElementById('calNextBtn');
  const calTodayBtn = document.getElementById('calTodayBtn');

  let calendarViewDate = (function () {
    const t = dateOffset(0);
    return new Date(t.getFullYear(), t.getMonth(), 1);
  })();

  function renderCalendar() {
    const year = calendarViewDate.getFullYear();
    const month = calendarViewDate.getMonth();
    calendarTitleEl.textContent = calendarViewDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

    if (!calendarWeekdaysEl.children.length) {
      ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].forEach((d) => {
        const span = document.createElement('span');
        span.textContent = d;
        calendarWeekdaysEl.appendChild(span);
      });
    }

    calendarGridEl.innerHTML = '';

    const firstOfMonth = new Date(year, month, 1);
    const startWeekday = firstOfMonth.getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const daysInPrevMonth = new Date(year, month, 0).getDate();
    const todayIso = isoDate(dateOffset(0));

    for (let i = 0; i < 42; i++) {
      const cellIndex = i - startWeekday + 1;
      let cellDate;
      let muted = false;

      if (cellIndex < 1) {
        cellDate = new Date(year, month - 1, daysInPrevMonth + cellIndex);
        muted = true;
      } else if (cellIndex > daysInMonth) {
        cellDate = new Date(year, month + 1, cellIndex - daysInMonth);
        muted = true;
      } else {
        cellDate = new Date(year, month, cellIndex);
      }

      const cellIso = isoDate(cellDate);
      const dayAppts = DataStore.getByDate(cellIso);

      const cell = document.createElement('div');
      cell.className = 'calendar-day';
      if (muted) cell.classList.add('calendar-day--muted');
      if (cellIso === todayIso) cell.classList.add('calendar-day--today');
      if (dayAppts.length > 0) {
        cell.classList.add('calendar-day--has-appts');
        cell.title = dayAppts.map((a) => a.name).join(', ');
      }
      cell.dataset.date = cellIso;

      const num = document.createElement('span');
      num.className = 'calendar-day__num';
      num.textContent = String(cellDate.getDate());
      cell.appendChild(num);

      if (dayAppts.length > 0) {
        const dotsWrap = document.createElement('div');
        dotsWrap.className = 'calendar-day__dots';
        const uniqueTypes = [...new Set(dayAppts.map((a) => a.type))].slice(0, 4);
        uniqueTypes.forEach((t) => {
          const dot = document.createElement('span');
          const color = (TYPE_META[t] || TYPE_META.counselling).color;
          dot.className = `dot dot--${color}`;
          dotsWrap.appendChild(dot);
        });
        cell.appendChild(dotsWrap);

        const count = document.createElement('span');
        count.className = 'calendar-day__count';
        count.textContent = String(dayAppts.length);
        cell.appendChild(count);
      }

      cell.addEventListener('click', () => openDayModal(cellIso));
      calendarGridEl.appendChild(cell);
    }
  }

  calPrevBtn.addEventListener('click', () => {
    calendarViewDate = new Date(calendarViewDate.getFullYear(), calendarViewDate.getMonth() - 1, 1);
    renderCalendar();
  });
  calNextBtn.addEventListener('click', () => {
    calendarViewDate = new Date(calendarViewDate.getFullYear(), calendarViewDate.getMonth() + 1, 1);
    renderCalendar();
  });
  calTodayBtn.addEventListener('click', () => {
    const t = dateOffset(0);
    calendarViewDate = new Date(t.getFullYear(), t.getMonth(), 1);
    renderCalendar();
  });

  /* ======================================================================
     DAY DETAIL MODAL
     ====================================================================== */

  const dayModalOverlay = document.getElementById('dayModalOverlay');
  const dayModalTitleEl = document.getElementById('dayModalTitle');
  const dayModalAddBtn = document.getElementById('dayModalAddBtn');
  const dayModalCloseBtn = document.getElementById('dayModalCloseBtn');
  const dayModalListEl = document.getElementById('dayModalList');
  const dayModalEmptyEl = document.getElementById('dayModalEmpty');

  let activeDayIso = null;

  function openDayModal(dateIso) {
    activeDayIso = dateIso;
    const d = parseISODate(dateIso);
    dayModalTitleEl.textContent = d.toLocaleDateString('en-US', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
    renderDayModalList();
    dayModalOverlay.hidden = false;
  }
  function closeDayModal() {
    dayModalOverlay.hidden = true;
    activeDayIso = null;
  }
  function renderDayModalList() {
    const list = DataStore.query({ date: activeDayIso, sort: 'asc' });
    dayModalListEl.innerHTML = '';
    if (list.length === 0) {
      dayModalEmptyEl.hidden = false;
    } else {
      dayModalEmptyEl.hidden = true;
      list.forEach((appt) => dayModalListEl.appendChild(renderPatientCard(apptAsPatient(appt), { nextLabel: 'Appointment' })));
    }
  }

  dayModalAddBtn.addEventListener('click', () => {
    const dateForNewAppt = activeDayIso;
    closeDayModal();
    openApptModal({ mode: 'add', date: dateForNewAppt });
  });
  dayModalCloseBtn.addEventListener('click', closeDayModal);
  dayModalOverlay.addEventListener('click', (e) => {
    if (e.target === dayModalOverlay) closeDayModal();
  });

  /* ======================================================================
     ADD / EDIT APPOINTMENT MODAL
     ====================================================================== */

  const apptModalOverlay = document.getElementById('apptModalOverlay');
  const apptModalTitleEl = document.getElementById('apptModalTitle');
  const apptModalDateLabelEl = document.getElementById('apptModalDateLabel');
  const apptModalDateFieldEl = document.getElementById('apptModalDateField');
  const apptModalDateInputEl = document.getElementById('apptModalDateInput');
  const apptModalDateError = document.getElementById('apptModalDateError');
  const apptModalDateHidden = document.getElementById('apptModalDate');
  const apptModalIdHidden = document.getElementById('apptModalId');
  const apptModalTitleSelect = document.getElementById('apptModalTitleSelect');
  const apptModalTypeSelect = document.getElementById('apptModalType');
  const apptModalNameInput = document.getElementById('apptModalName');
  const apptModalNameError = document.getElementById('apptModalNameError');
  const apptModalMobileInput = document.getElementById('apptModalMobile');
  const apptModalMobileError = document.getElementById('apptModalMobileError');
  const apptModalTimeError = document.getElementById('apptModalTimeError');
  const apptModalNotesInput = document.getElementById('apptModalNotes');
  const apptModalConflictWarning = document.getElementById('apptModalConflictWarning');
  const apptModalCancelBtn = document.getElementById('apptModalCancelBtn');
  const apptModalSaveBtn = document.getElementById('apptModalSaveBtn');

  const apptModalTimePicker = createTimePicker({
    hourEl: document.getElementById('apptModalTimeHour'),
    minuteEl: document.getElementById('apptModalTimeMinute'),
    amBtn: document.getElementById('apptModalTimeAM'),
    pmBtn: document.getElementById('apptModalTimePM'),
    hiddenEl: document.getElementById('apptModalTime'),
    wrapperEl: document.getElementById('apptModalTimePicker')
  });

  let apptModalMode = 'add';
  let apptModalOriginalType = null;
  let apptModalOriginalStatus = null;

  function openApptModal({ mode, date, appt, prefill }) {
    apptModalMode = mode;
    apptModalIdHidden.value = appt ? appt.id : '';
    apptModalTitleEl.textContent = mode === 'edit' ? 'Edit Appointment' : 'Add Appointment';
    apptModalOriginalType = appt ? appt.type : null;
    apptModalOriginalStatus = appt ? (appt.status || 'scheduled') : null;

    // No calendar day was pre-selected (e.g. "Schedule Next Appointment" from
    // the Patients tab) — show a real date input instead of the usual
    // "For <date>" label, since there's no context to read the date from.
    const needsDateInput = !appt && !date;
    apptModalDateFieldEl.hidden = !needsDateInput;
    apptModalDateLabelEl.hidden = needsDateInput;

    if (needsDateInput) {
      const defaultDate = isoDate(dateOffset(1)); // tomorrow — a sensible default for a "next" appointment
      apptModalDateInputEl.value = defaultDate;
      apptModalDateInputEl.min = isoDate(dateOffset(0)); // can't schedule into the past
      apptModalDateHidden.value = defaultDate;
      clearFieldError(apptModalDateInputEl, apptModalDateError);
    } else {
      const targetDate = appt ? appt.date : date;
      apptModalDateHidden.value = targetDate;
      apptModalDateLabelEl.textContent = 'For ' + parseISODate(targetDate).toLocaleDateString('en-US', {
        weekday: 'long', day: '2-digit', month: 'long', year: 'numeric'
      });
    }

    apptModalTitleSelect.value = appt ? appt.title : 'Ms.';
    apptModalTypeSelect.value = appt ? appt.type : (prefill ? 'followup' : 'counselling');
    apptModalNameInput.value = appt ? appt.name : (prefill ? prefill.name : '');
    apptModalMobileInput.value = appt ? appt.mobile : (prefill ? prefill.mobile : '');
    apptModalNotesInput.value = appt ? (appt.notes || '') : '';
    apptModalTimePicker.setValue(appt ? appt.time : '');

    // Scheduling a known patient's next appointment: lock name/mobile since
    // together they're how patients are identified (no separate patient
    // record exists) — changing them here would silently create a
    // different "patient" instead of adding to this one's history.
    const lockIdentity = !!prefill && !appt;
    apptModalNameInput.readOnly = lockIdentity;
    apptModalMobileInput.readOnly = lockIdentity;
    apptModalNameInput.classList.toggle('field__input--readonly', lockIdentity);
    apptModalMobileInput.classList.toggle('field__input--readonly', lockIdentity);

    clearFieldError(apptModalNameInput, apptModalNameError);
    clearFieldError(apptModalMobileInput, apptModalMobileError);
    markFieldErrorVisible(apptModalTimeError, false);
    apptModalTimePicker.setInvalid(false);
    apptModalConflictWarning.hidden = true;

    apptModalOverlay.hidden = false;
    setTimeout(() => (needsDateInput ? apptModalDateInputEl : apptModalNameInput).focus(), 50);
  }

  function closeApptModal() {
    apptModalOverlay.hidden = true;
  }

  apptModalCancelBtn.addEventListener('click', closeApptModal);
  apptModalOverlay.addEventListener('click', (e) => {
    if (e.target === apptModalOverlay) closeApptModal();
  });

  apptModalMobileInput.addEventListener('input', () => {
    apptModalMobileInput.value = onlyDigits(apptModalMobileInput.value).slice(0, 10);
  });

  apptModalSaveBtn.addEventListener('click', () => {
    const name = apptModalNameInput.value.trim();
    const mobile = apptModalMobileInput.value.trim();
    const time = document.getElementById('apptModalTime').value;
    const type = apptModalTypeSelect.value;

    const nameValid = name.length > 0;
    const mobileValid = isValidMobile(mobile);
    const timeValid = time.length > 0;

    setFieldError(apptModalNameInput, apptModalNameError, !nameValid);
    setFieldError(apptModalMobileInput, apptModalMobileError, !mobileValid);
    markFieldErrorVisible(apptModalTimeError, !timeValid);
    apptModalTimePicker.setInvalid(!timeValid);

    // When there was no pre-selected calendar day, the date comes from the
    // visible date input instead — validate and sync it into the same
    // hidden field the rest of this handler already reads from.
    const usingDateInput = !apptModalDateFieldEl.hidden;
    let dateValid = true;
    if (usingDateInput) {
      dateValid = apptModalDateInputEl.value.length > 0;
      setFieldError(apptModalDateInputEl, apptModalDateError, !dateValid);
      if (dateValid) apptModalDateHidden.value = apptModalDateInputEl.value;
    }

    if (!nameValid || !mobileValid || !timeValid || !dateValid) return;

    // Prevent accidentally creating two active appointments for the same
    // patient at the exact same date & time (e.g. a double-tap on Save, or
    // scheduling a "next" appointment that collides with an existing one).
    const conflict = DataStore.getAll().some((a) =>
      a.id !== apptModalIdHidden.value &&
      a.mobile === mobile &&
      a.date === apptModalDateHidden.value &&
      a.time === time &&
      (a.status || 'scheduled') !== 'cancelled'
    );
    apptModalConflictWarning.hidden = !conflict;
    if (conflict) return;

    const data = {
      title: apptModalTitleSelect.value,
      name,
      mobile,
      date: apptModalDateHidden.value,
      time,
      type,
      notes: apptModalNotesInput.value.trim()
    };

    // Selecting "Cancelled" as the type is the trigger for the full
    // cancellation workflow (confirmation + required reason + WhatsApp
    // notice) — but only when it's a genuinely new cancellation, not when
    // re-saving an appointment that was already cancelled.
    const isNewCancellation = type === 'cancelled' && apptModalOriginalStatus !== 'cancelled';

    if (isNewCancellation) {
      openCancelConfirmDialog({
        name, date: data.date, time,
        onConfirm: (reason) => {
          const finalData = Object.assign({}, data, {
            status: 'cancelled',
            cancelledAt: new Date().toISOString(),
            cancellationReason: reason
          });

          if (apptModalMode === 'edit' && apptModalIdHidden.value) {
            const snapshot = DataStore.getById(apptModalIdHidden.value);
            DataStore.update(apptModalIdHidden.value, finalData);
            logActivity('Appointment Cancelled', apptModalIdHidden.value, { reason });
            closeApptModal();
            refreshEverything();
            if (!dayModalOverlay.hidden) renderDayModalList();
            openWhatsApp(mobile, generateCancellationMessage(finalData, reason));
            scheduleUndo('Appointment cancelled successfully.', 'replace', apptModalIdHidden.value, snapshot);
          } else {
            const created = DataStore.add(finalData);
            logActivity('Appointment Created', created.id);
            logActivity('Appointment Cancelled', created.id, { reason });
            closeApptModal();
            refreshEverything();
            if (!dayModalOverlay.hidden) renderDayModalList();
            openWhatsApp(mobile, generateCancellationMessage(finalData, reason));
            scheduleUndo('Appointment cancelled successfully.', 'delete', created.id);
          }
        }
      });
      return;
    }

    if (apptModalMode === 'edit' && apptModalIdHidden.value) {
      // Preserve the existing lifecycle status unless the type change implies
      // a new one (e.g. marking the type as Completed).
      data.status = type === 'completed' ? 'completed' : apptModalOriginalStatus;
      DataStore.update(apptModalIdHidden.value, data);
      logActivity('Appointment Updated', apptModalIdHidden.value);
      showToast('Appointment updated.');
    } else {
      data.status = type === 'completed' ? 'completed' : 'scheduled';
      const created = DataStore.add(data);
      logActivity('Appointment Created', created.id);
      showToast('Appointment added.');
    }

    closeApptModal();
    refreshEverything();
    if (!dayModalOverlay.hidden) renderDayModalList();
  });

  /* ======================================================================
     CANCEL APPOINTMENT — CONFIRMATION DIALOG
     ====================================================================== */

  const cancelConfirmOverlay = document.getElementById('cancelConfirmOverlay');
  const cancelConfirmNameEl = document.getElementById('cancelConfirmName');
  const cancelConfirmDateTimeEl = document.getElementById('cancelConfirmDateTime');
  const cancelReasonSelect = document.getElementById('cancelReasonSelect');
  const cancelReasonError = document.getElementById('cancelReasonError');
  const cancelReasonOtherField = document.getElementById('cancelReasonOtherField');
  const cancelReasonOtherInput = document.getElementById('cancelReasonOther');
  const cancelReasonOtherError = document.getElementById('cancelReasonOtherError');
  const cancelConfirmKeepBtn = document.getElementById('cancelConfirmKeepBtn');
  const cancelConfirmProceedBtn = document.getElementById('cancelConfirmProceedBtn');

  let pendingCancelConfirm = null; // the onConfirm callback for the appointment being cancelled

  function openCancelConfirmDialog({ name, date, time, onConfirm }) {
    cancelConfirmNameEl.textContent = name;
    cancelConfirmDateTimeEl.textContent = `${formatDateInputValue(date)} · ${formatTime12h(time)}`;
    cancelReasonSelect.value = '';
    cancelReasonOtherInput.value = '';
    cancelReasonOtherField.hidden = true;
    clearFieldError(cancelReasonSelect, cancelReasonError);
    clearFieldError(cancelReasonOtherInput, cancelReasonOtherError);
    pendingCancelConfirm = onConfirm;
    cancelConfirmOverlay.hidden = false;
  }

  function closeCancelConfirmDialog() {
    cancelConfirmOverlay.hidden = true;
    pendingCancelConfirm = null;
  }

  cancelReasonSelect.addEventListener('change', () => {
    cancelReasonOtherField.hidden = cancelReasonSelect.value !== 'Other';
  });

  cancelConfirmKeepBtn.addEventListener('click', closeCancelConfirmDialog);
  cancelConfirmOverlay.addEventListener('click', (e) => {
    if (e.target === cancelConfirmOverlay) closeCancelConfirmDialog();
  });

  cancelConfirmProceedBtn.addEventListener('click', () => {
    const reasonChoice = cancelReasonSelect.value;
    const reasonValid = reasonChoice.length > 0;
    setFieldError(cancelReasonSelect, cancelReasonError, !reasonValid);
    if (!reasonValid) return;

    let finalReason = reasonChoice;
    if (reasonChoice === 'Other') {
      const customReason = cancelReasonOtherInput.value.trim();
      const otherValid = customReason.length > 0;
      setFieldError(cancelReasonOtherInput, cancelReasonOtherError, !otherValid);
      if (!otherValid) return;
      finalReason = customReason;
    }

    const callback = pendingCancelConfirm;
    closeCancelConfirmDialog();
    if (typeof callback === 'function') callback(finalReason);
  });

  /* ======================================================================
     RESCHEDULE APPOINTMENT MODAL
     ====================================================================== */

  const rescheduleModalOverlay = document.getElementById('rescheduleModalOverlay');
  const rescheduleModalNameEl = document.getElementById('rescheduleModalName');
  const rescheduleModalCurrentEl = document.getElementById('rescheduleModalCurrent');
  const rescheduleModalIdHidden = document.getElementById('rescheduleModalId');
  const rescheduleDateInput = document.getElementById('rescheduleDate');
  const rescheduleDateError = document.getElementById('rescheduleDateError');
  const rescheduleTimeError = document.getElementById('rescheduleTimeError');
  const rescheduleReasonSelect = document.getElementById('rescheduleReasonSelect');
  const rescheduleReasonOtherField = document.getElementById('rescheduleReasonOtherField');
  const rescheduleReasonOtherInput = document.getElementById('rescheduleReasonOther');
  const rescheduleCancelBtn = document.getElementById('rescheduleCancelBtn');
  const rescheduleSaveBtn = document.getElementById('rescheduleSaveBtn');

  const rescheduleTimePicker = createTimePicker({
    hourEl: document.getElementById('rescheduleTimeHour'),
    minuteEl: document.getElementById('rescheduleTimeMinute'),
    amBtn: document.getElementById('rescheduleTimeAM'),
    pmBtn: document.getElementById('rescheduleTimePM'),
    hiddenEl: document.getElementById('rescheduleTime'),
    wrapperEl: document.getElementById('rescheduleTimePicker')
  });

  function openRescheduleModal(appt) {
    rescheduleModalIdHidden.value = appt.id;
    rescheduleModalNameEl.textContent = `${appt.title} ${appt.name}`;
    rescheduleModalCurrentEl.textContent = `Current: ${formatDateInputValue(appt.date)} · ${formatTime12h(appt.time)}`;

    rescheduleDateInput.value = appt.date;
    rescheduleTimePicker.setValue(appt.time);
    rescheduleReasonSelect.value = '';
    rescheduleReasonOtherInput.value = '';
    rescheduleReasonOtherField.hidden = true;

    clearFieldError(rescheduleDateInput, rescheduleDateError);
    markFieldErrorVisible(rescheduleTimeError, false);
    rescheduleTimePicker.setInvalid(false);

    rescheduleModalOverlay.hidden = false;
  }

  function closeRescheduleModal() {
    rescheduleModalOverlay.hidden = true;
  }

  rescheduleReasonSelect.addEventListener('change', () => {
    rescheduleReasonOtherField.hidden = rescheduleReasonSelect.value !== 'Other';
  });

  rescheduleCancelBtn.addEventListener('click', closeRescheduleModal);
  rescheduleModalOverlay.addEventListener('click', (e) => {
    if (e.target === rescheduleModalOverlay) closeRescheduleModal();
  });

  rescheduleSaveBtn.addEventListener('click', () => {
    const apptId = rescheduleModalIdHidden.value;
    const appt = DataStore.getById(apptId);
    if (!appt) return;

    const newDate = rescheduleDateInput.value;
    const newTime = document.getElementById('rescheduleTime').value;

    const dateValid = newDate.length > 0;
    const timeValid = newTime.length > 0;
    setFieldError(rescheduleDateInput, rescheduleDateError, !dateValid);
    markFieldErrorVisible(rescheduleTimeError, !timeValid);
    rescheduleTimePicker.setInvalid(!timeValid);
    if (!dateValid || !timeValid) return;

    let reason = rescheduleReasonSelect.value;
    if (reason === 'Other') {
      reason = rescheduleReasonOtherInput.value.trim();
    }

    const snapshot = Object.assign({}, appt);
    const oldDate = appt.date;
    const oldTime = appt.time;
    const history = Array.isArray(appt.history) ? appt.history.slice() : [];
    history.push({ date: oldDate, time: oldTime, changedAt: new Date().toISOString() });

    const patch = {
      date: newDate,
      time: newTime,
      status: 'rescheduled',
      history
    };
    if (reason) patch.rescheduleReason = reason;

    DataStore.update(apptId, patch);
    logActivity('Appointment Rescheduled', apptId, { from: `${oldDate} ${oldTime}`, to: `${newDate} ${newTime}` });
    closeRescheduleModal();
    refreshEverything();
    if (!dayModalOverlay.hidden) renderDayModalList();

    const updatedAppt = DataStore.getById(apptId);
    openWhatsApp(appt.mobile, generateRescheduleMessage(updatedAppt, oldDate, oldTime, newDate, newTime));
    scheduleUndo('Appointment rescheduled successfully.', 'replace', apptId, snapshot);
  });

  /* ======================================================================
     PATIENT CARD POPUPS — View Appointments / Send Reminder / More Options /
     Cancel (direct). These reuse the same DataStore, WhatsApp, toast and
     undo plumbing as the modals above; they just give the Patients tab its
     own dedicated entry points so only one popup is ever on screen at once.
     ====================================================================== */

  /** Closes every popup that can be reached from a patient card, so opening
   *  a new one never stacks on top of an old one. */
  function closeAllActionPopups() {
    apptModalOverlay.hidden = true;
    rescheduleModalOverlay.hidden = true;
    cancelConfirmOverlay.hidden = true;
    dayModalOverlay.hidden = true;
    patientHistoryModalOverlay.hidden = true;
    sendReminderModalOverlay.hidden = true;
  }

  /* ---------- View Appointments ---------- */
  const patientHistoryModalOverlay = document.getElementById('patientHistoryModalOverlay');
  const patientHistoryModalTitle = document.getElementById('patientHistoryModalTitle');
  const patientHistoryList = document.getElementById('patientHistoryList');
  const patientHistoryEmpty = document.getElementById('patientHistoryEmpty');
  const patientHistoryCloseBtn = document.getElementById('patientHistoryCloseBtn');

  function openPatientHistoryModal(patient) {
    closeAllActionPopups();
    patientHistoryModalTitle.textContent = `${patient.title} ${patient.name} — Appointments`;
    const appts = DataStore.getAll()
      .filter((a) => (a.mobile || '').trim() === patient.mobile)
      .sort((a, b) => `${b.date} ${b.time}`.localeCompare(`${a.date} ${a.time}`));

    patientHistoryList.innerHTML = '';
    patientHistoryEmpty.hidden = appts.length > 0;
    appts.forEach((a) => patientHistoryList.appendChild(renderPatientCard(apptAsPatient(a), { showDate: true, nextLabel: 'Appointment' })));
    patientHistoryModalOverlay.hidden = false;
  }

  function closePatientHistoryModal() {
    patientHistoryModalOverlay.hidden = true;
  }

  patientHistoryCloseBtn.addEventListener('click', closePatientHistoryModal);
  patientHistoryModalOverlay.addEventListener('click', (e) => {
    if (e.target === patientHistoryModalOverlay) closePatientHistoryModal();
  });

  /* ---------- Send Reminder ---------- */
  const sendReminderModalOverlay = document.getElementById('sendReminderModalOverlay');
  const sendReminderName = document.getElementById('sendReminderName');
  const sendReminderDateTime = document.getElementById('sendReminderDateTime');
  const sendReminderPreview = document.getElementById('sendReminderPreview');
  const sendReminderCancelBtn = document.getElementById('sendReminderCancelBtn');
  const sendReminderSendBtn = document.getElementById('sendReminderSendBtn');

  let pendingReminderAppt = null;

  function openSendReminderModal(appt) {
    closeAllActionPopups();
    pendingReminderAppt = appt;
    sendReminderName.textContent = `${appt.title} ${appt.name}`;
    sendReminderDateTime.textContent = `${formatDateInputValue(appt.date)} · ${formatTime12h(appt.time)}`;
    sendReminderPreview.value = generateAppointmentMessage(appt);
    sendReminderModalOverlay.hidden = false;
  }

  function closeSendReminderModal() {
    sendReminderModalOverlay.hidden = true;
    pendingReminderAppt = null;
  }

  sendReminderCancelBtn.addEventListener('click', closeSendReminderModal);
  sendReminderModalOverlay.addEventListener('click', (e) => {
    if (e.target === sendReminderModalOverlay) closeSendReminderModal();
  });

  sendReminderSendBtn.addEventListener('click', () => {
    const message = sendReminderPreview.value.trim();
    if (!message || !pendingReminderAppt) return; // validation failure — keep popup open
    const appt = pendingReminderAppt;
    openWhatsApp(appt.mobile, message);
    logActivity('Reminder Sent', appt.id);
    closeSendReminderModal();
    showToast('Reminder sent successfully.');
  });

  /* ---------- Cancel Appointment (direct from patient card) ---------- */
  function cancelPatientAppointment(appt) {
    closeAllActionPopups();
    openCancelConfirmDialog({
      name: `${appt.title} ${appt.name}`,
      date: appt.date,
      time: appt.time,
      onConfirm: (reason) => {
        const snapshot = DataStore.getById(appt.id);
        DataStore.update(appt.id, {
          status: 'cancelled',
          cancelledAt: new Date().toISOString(),
          cancellationReason: reason
        });
        logActivity('Appointment Cancelled', appt.id, { reason });
        refreshEverything();
        if (!dayModalOverlay.hidden) renderDayModalList();
        openWhatsApp(appt.mobile, generateCancellationMessage(appt, reason));
        scheduleUndo('Appointment cancelled successfully.', 'replace', appt.id, snapshot);
        showToast('Appointment cancelled successfully.');
      }
    });
  }

  /* ======================================================================
     DOCTOR REMINDER TAB (auto-read only, no manual entry)
     ====================================================================== */

  const todayListEl = document.getElementById('todayList');
  const tomorrowListEl = document.getElementById('tomorrowList');
  const todayEmptyEl = document.getElementById('todayEmpty');
  const tomorrowEmptyEl = document.getElementById('tomorrowEmpty');
  const todayDateLabel = document.getElementById('todayDateLabel');
  const tomorrowDateLabel = document.getElementById('tomorrowDateLabel');
  const reminderPreviewEl = document.getElementById('reminderPreview');
  const reminderTimestampEl = document.getElementById('reminderTimestamp');

  function initReminderDateLabels() {
    todayDateLabel.textContent = `Today's Appointments · ${weekdayName(dateOffset(0))}`;
    tomorrowDateLabel.textContent = `Tomorrow's Appointments · ${weekdayName(dateOffset(1))}`;
  }

  /* generateReminderMessage now imported from templates/appointmentTemplates.js */

  function renderReminderLists() {
    const todayIso = isoDate(dateOffset(0));
    const tomorrowIso = isoDate(dateOffset(1));
    const todayList = DataStore.query({ date: todayIso, sort: 'asc' });
    const tomorrowList = DataStore.query({ date: tomorrowIso, sort: 'asc' });

    todayListEl.innerHTML = '';
    if (todayList.length === 0) {
      todayEmptyEl.hidden = false;
    } else {
      todayEmptyEl.hidden = true;
      todayList.forEach((a) => todayListEl.appendChild(renderApptCard(a, { showActions: false })));
    }

    tomorrowListEl.innerHTML = '';
    if (tomorrowList.length === 0) {
      tomorrowEmptyEl.hidden = false;
    } else {
      tomorrowEmptyEl.hidden = true;
      tomorrowList.forEach((a) => tomorrowListEl.appendChild(renderApptCard(a, { showActions: false })));
    }

    reminderPreviewEl.textContent = generateReminderMessage(todayList, tomorrowList);
    reminderTimestampEl.textContent = currentTimeLabel();
  }

  document.getElementById('copyReminderBtn').addEventListener('click', () => {
    copyToClipboard(reminderPreviewEl.textContent);
  });
  document.getElementById('sendDoctorBtn').addEventListener('click', () => {
    openWhatsApp(DOCTOR_NUMBER, reminderPreviewEl.textContent);
    logActivity('Reminder Sent', null);
  });

  /* ======================================================================
     ALL APPOINTMENTS TAB (search, filter, sort, export)
     ====================================================================== */

  const searchInput = document.getElementById('searchInput');
  const filterDateInput = document.getElementById('filterDate');
  const filterTypeSelect = document.getElementById('filterType');
  const filterStatusSelect = document.getElementById('filterStatus');
  const sortOrderSelect = document.getElementById('sortOrder');
  const clearFiltersBtn = document.getElementById('clearFiltersBtn');
  const allAppointmentsListEl = document.getElementById('allAppointmentsList');
  const allAppointmentsEmptyEl = document.getElementById('allAppointmentsEmpty');
  const allAppointmentsCountEl = document.getElementById('allAppointmentsCount');
  const exportCsvBtn = document.getElementById('exportCsvBtn');
  const printScheduleBtn = document.getElementById('printScheduleBtn');

  function currentFilters() {
    return {
      search: searchInput.value,
      date: filterDateInput.value || undefined,
      type: filterTypeSelect.value,
      status: filterStatusSelect.value,
      sort: sortOrderSelect.value
    };
  }

  function renderAllAppointments() {
    const list = DataStore.query(currentFilters());
    allAppointmentsCountEl.textContent = `${list.length} appointment${list.length === 1 ? '' : 's'}`;
    allAppointmentsListEl.innerHTML = '';
    if (list.length === 0) {
      allAppointmentsEmptyEl.hidden = false;
    } else {
      allAppointmentsEmptyEl.hidden = true;
      list.forEach((a) => allAppointmentsListEl.appendChild(renderApptCard(a, { showActions: true, showDate: true })));
    }
  }

  [searchInput, filterDateInput, filterTypeSelect, filterStatusSelect, sortOrderSelect].forEach((el) => {
    el.addEventListener('input', renderAllAppointments);
    el.addEventListener('change', renderAllAppointments);
  });

  clearFiltersBtn.addEventListener('click', () => {
    searchInput.value = '';
    filterDateInput.value = '';
    filterTypeSelect.value = 'all';
    filterStatusSelect.value = 'all';
    sortOrderSelect.value = 'asc';
    renderAllAppointments();
  });

  /* ======================================================================
     EXPORT CSV MODULE
     Dedicated modal: From/To date + Status/Type filters, mirroring the
     Print Schedule modal. Confirming builds and downloads the CSV, then
     auto-closes the dialog.
     ====================================================================== */

  const exportModalOverlay = document.getElementById('exportModalOverlay');
  const exportModalFromInput = document.getElementById('exportModalFrom');
  const exportModalToInput = document.getElementById('exportModalTo');
  const exportModalFromError = document.getElementById('exportModalFromError');
  const exportModalToError = document.getElementById('exportModalToError');
  const exportModalStatusSelect = document.getElementById('exportModalStatus');
  const exportModalTypeSelect = document.getElementById('exportModalType');
  const exportModalCancelBtn = document.getElementById('exportModalCancelBtn');
  const exportModalConfirmBtn = document.getElementById('exportModalConfirmBtn');

  function openExportModal() {
    const todayIso = isoDate(dateOffset(0));
    exportModalFromInput.value = todayIso;
    exportModalToInput.value = todayIso;
    exportModalStatusSelect.value = 'all';
    exportModalTypeSelect.value = 'all';
    clearFieldError(exportModalFromInput, exportModalFromError);
    clearFieldError(exportModalToInput, exportModalToError);
    exportModalOverlay.hidden = false;
  }
  function closeExportModal() {
    exportModalOverlay.hidden = true;
  }
  exportCsvBtn.addEventListener('click', openExportModal);
  exportModalCancelBtn.addEventListener('click', closeExportModal);
  exportModalOverlay.addEventListener('click', (e) => {
    if (e.target === exportModalOverlay) closeExportModal();
  });

  function csvEscape(val) {
    const s = String(val == null ? '' : val);
    if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  exportModalConfirmBtn.addEventListener('click', () => {
    const fromValid = !!exportModalFromInput.value;
    const toValid = !!exportModalToInput.value;
    setFieldError(exportModalFromInput, exportModalFromError, !fromValid);
    setFieldError(exportModalToInput, exportModalToError, !toValid);
    if (!fromValid || !toValid) return;

    let fromIso = exportModalFromInput.value;
    let toIso = exportModalToInput.value;
    if (fromIso > toIso) { const tmp = fromIso; fromIso = toIso; toIso = tmp; }

    const status = exportModalStatusSelect.value;
    const type = exportModalTypeSelect.value;
    const list = DataStore.query({ status, type, sort: 'asc' })
      .filter((a) => a.date >= fromIso && a.date <= toIso);

    const header = ['Title', 'Name', 'Mobile', 'Date', 'Time', 'Type', 'Status', 'Notes'];
    const rows = list.map((a) => [
      a.title, a.name, a.mobile, a.date, formatTime12h(a.time),
      (TYPE_META[a.type] || TYPE_META.counselling).label,
      (STATUS_META[a.status] || STATUS_META.scheduled).label,
      (a.notes || '').replace(/\n/g, ' ')
    ]);
    const csv = [header, ...rows].map((r) => r.map(csvEscape).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fromIso === toIso
      ? `clinic-appointments-${fromIso}.csv`
      : `clinic-appointments-${fromIso}_to_${toIso}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    closeExportModal(); // auto-close: dialog closes once the export starts
    logActivity('Export CSV', null, { from: fromIso, to: toIso, count: list.length });
    showToast(`Exported ${list.length} appointment${list.length === 1 ? '' : 's'} as CSV.`);
  });

  /* ======================================================================
     PRINT SCHEDULE MODULE
     Dedicated modal: From/To date + Status/Type filters, with
     "Print Schedule" (print immediately) and "Print Preview" (review
     on screen first) actions. Both share one renderer so the printed
     page and the preview always match exactly.
     ====================================================================== */

  const printModalOverlay = document.getElementById('printModalOverlay');
  const printModalFromInput = document.getElementById('printModalFrom');
  const printModalToInput = document.getElementById('printModalTo');
  const printModalFromError = document.getElementById('printModalFromError');
  const printModalToError = document.getElementById('printModalToError');
  const printModalStatusSelect = document.getElementById('printModalStatus');
  const printModalTypeSelect = document.getElementById('printModalType');
  const printModalCancelBtn = document.getElementById('printModalCancelBtn');
  const printModalPreviewBtn = document.getElementById('printModalPreviewBtn');
  const printModalImageBtn = document.getElementById('printModalImageBtn');
  const printModalPrintBtn = document.getElementById('printModalPrintBtn');

  const printPreviewOverlay = document.getElementById('printPreviewOverlay');
  const printPreviewContentEl = document.getElementById('printPreviewContent');
  const printPreviewCloseBtn = document.getElementById('printPreviewCloseBtn');
  const printPreviewBackBtn = document.getElementById('printPreviewBackBtn');
  const printPreviewImageBtn = document.getElementById('printPreviewImageBtn');
  const printPreviewPrintBtn = document.getElementById('printPreviewPrintBtn');
  const printThemeSwatches = document.getElementById('printThemeSwatches');

  const printScheduleEl = document.getElementById('printSchedule');
  const printScheduleTitleEl = document.getElementById('printScheduleTitle');
  const printScheduleRangeEl = document.getElementById('printScheduleRange');
  const printScheduleGeneratedEl = document.getElementById('printScheduleGenerated');
  const printScheduleBodyEl = document.getElementById('printScheduleBody');

  function openPrintModal() {
    const todayIso = isoDate(dateOffset(0));
    printModalFromInput.value = todayIso;
    printModalToInput.value = todayIso;
    printModalStatusSelect.value = 'all';
    printModalTypeSelect.value = 'all';
    clearFieldError(printModalFromInput, printModalFromError);
    clearFieldError(printModalToInput, printModalToError);
    printModalOverlay.hidden = false;
  }
  function closePrintModal() {
    printModalOverlay.hidden = true;
  }
  printScheduleBtn.addEventListener('click', openPrintModal);
  printModalCancelBtn.addEventListener('click', closePrintModal);
  printModalOverlay.addEventListener('click', (e) => {
    if (e.target === printModalOverlay) closePrintModal();
  });

  /** Reads + validates the modal's fields. Returns null (and shows field
   *  errors) if invalid, otherwise the resolved filter set. */
  function readPrintFilters() {
    const fromValid = !!printModalFromInput.value;
    const toValid = !!printModalToInput.value;
    setFieldError(printModalFromInput, printModalFromError, !fromValid);
    setFieldError(printModalToInput, printModalToError, !toValid);
    if (!fromValid || !toValid) return null;

    let fromIso = printModalFromInput.value;
    let toIso = printModalToInput.value;
    if (fromIso > toIso) {
      const tmp = fromIso; fromIso = toIso; toIso = tmp;
    }
    return {
      fromIso, toIso,
      status: printModalStatusSelect.value,
      type: printModalTypeSelect.value
    };
  }

  function buildPrintList(filters) {
    return DataStore.query({ status: filters.status, type: filters.type, sort: 'asc' })
      .filter((a) => a.date >= filters.fromIso && a.date <= filters.toIso);
  }

  /** Renders the shared schedule markup into any container that has the
   *  same title/range/generated/body element ids as #printSchedule. */
  function renderScheduleInto(filters, list) {
    const single = filters.fromIso === filters.toIso;
    printScheduleTitleEl.textContent = single ? 'Daily Schedule' : 'Schedule Report';

    let rangeText = single
      ? formatDateInputValue(filters.fromIso)
      : `${formatDateInputValue(filters.fromIso)} to ${formatDateInputValue(filters.toIso)}`;
    const extra = [];
    if (filters.status !== 'all') extra.push('Status: ' + (STATUS_META[filters.status] || {}).label);
    if (filters.type !== 'all') extra.push('Type: ' + (TYPE_META[filters.type] || {}).label);
    if (extra.length) rangeText += ' · ' + extra.join(' · ');
    printScheduleRangeEl.textContent = rangeText;

    const now = new Date();
    printScheduleGeneratedEl.textContent = 'Generated On: ' + formatFullDate(now) + ', ' + formatTime12h(`${pad(now.getHours())}:${pad(now.getMinutes())}`);

    printScheduleBodyEl.innerHTML = '';
    if (list.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 7;
      td.textContent = 'No appointments found for the selected period.';
      td.style.textAlign = 'center';
      tr.appendChild(td);
      printScheduleBodyEl.appendChild(tr);
    } else {
      list.forEach((a) => {
        const tr = document.createElement('tr');
        tr.innerHTML =
          `<td>${formatDateInputValue(a.date)}</td>` +
          `<td>${formatTime12h(a.time)}</td>` +
          `<td>${escapeHtml(a.title)} ${escapeHtml(a.name)}</td>` +
          `<td>${escapeHtml(a.mobile)}</td>` +
          `<td>${escapeHtml((TYPE_META[a.type] || TYPE_META.counselling).label)}</td>` +
          `<td>${escapeHtml((STATUS_META[a.status] || STATUS_META.scheduled).label)}</td>` +
          `<td>${escapeHtml(a.notes || '')}</td>`;
        printScheduleBodyEl.appendChild(tr);
      });
    }
  }

  printModalPrintBtn.addEventListener('click', () => {
    const filters = readPrintFilters();
    if (!filters) return;
    const list = buildPrintList(filters);
    renderScheduleInto(filters, list);
    logActivity('Print Schedule', null, { from: filters.fromIso, to: filters.toIso });
    triggerPrint(); // modal closes once the task actually finishes (see triggerPrint below)
  });

  /* ---------- Save as Image (PNG snapshot of the schedule, via html2canvas) ---------- */
  function downloadCanvasAsPng(canvas, filename) {
    const link = document.createElement('a');
    link.download = filename;
    link.href = canvas.toDataURL('image/png');
    link.click();
  }

  async function exportScheduleAsImage(sourceEl, filters, button) {
    if (typeof html2canvas !== 'function') {
      window.alert('Image export needs an internet connection the first time — please check your connection and try again.');
      return;
    }
    const originalLabel = button ? button.innerHTML : null;
    if (button) {
      button.disabled = true;
      button.innerHTML = '<span class="material-symbols-rounded">hourglass_top</span> Saving…';
    }
    // Build an off-screen A4-portrait page (same width/margins as the
    // printed page) and capture that, so the PNG looks like an actual
    // portrait page rather than a tight crop of just the table.
    const mmToPx = 96 / 25.4;
    const pageWidth = Math.round(210 * mmToPx);   // ≈ 794px
    const pageMinHeight = Math.round(297 * mmToPx); // ≈ 1123px
    const marginX = Math.round(12 * mmToPx);       // ≈ 45px
    const marginY = Math.round(14 * mmToPx);       // ≈ 53px

    const pageWrap = document.createElement('div');
    pageWrap.style.cssText = `position:fixed; top:0; left:-99999px; width:${pageWidth}px; min-height:${pageMinHeight}px; box-sizing:border-box; padding:${marginY}px ${marginX}px; background:#fff;`;
    const clone = sourceEl.cloneNode(true);
    clone.style.cssText = 'display:block; margin:0; padding:0; border:none; max-height:none; overflow:visible;';
    pageWrap.appendChild(clone);
    document.body.appendChild(pageWrap);

    try {
      const canvas = await html2canvas(pageWrap, { scale: 2, backgroundColor: '#ffffff', useCORS: true });
      const from = filters ? filters.fromIso : null;
      const to = filters ? filters.toIso : null;
      // Same naming convention as the CSV export, so image/CSV/(future PDF)
      // downloads for the same range are easy to recognize together.
      const filename = from
        ? (from === to ? `clinic-appointments-${from}.png` : `clinic-appointments-${from}_to_${to}.png`)
        : 'clinic-appointments.png';
      downloadCanvasAsPng(canvas, filename);
      logActivity('Save Schedule Image', null, from ? { from, to } : {});
    } catch (err) {
      console.error('Save as Image failed:', err);
      window.alert('Could not generate the image. Please try again.');
    } finally {
      pageWrap.remove();
      if (button) {
        button.disabled = false;
        button.innerHTML = originalLabel;
      }
    }
  }

  printModalImageBtn.addEventListener('click', async () => {
    const filters = readPrintFilters();
    if (!filters) return;
    const list = buildPrintList(filters);
    renderScheduleInto(filters, list);
    await exportScheduleAsImage(printScheduleEl, filters, printModalImageBtn);
  });

  /* ---------- Colour theme picker (Print Preview) ---------- */
  printThemeSwatches.addEventListener('click', (e) => {
    const swatch = e.target.closest('.swatch');
    if (!swatch) return;
    const accent = swatch.dataset.accent;
    const accentText = swatch.dataset.text;
    // Set on the hidden template so print, "Save as Image", and any future
    // preview clones (cloneNode copies inline styles) all pick it up.
    printScheduleEl.style.setProperty('--print-accent', accent);
    printScheduleEl.style.setProperty('--print-accent-text', accentText);
    // Also update the currently-open preview clone immediately.
    const liveClone = printPreviewContentEl.querySelector('.print-schedule--preview');
    if (liveClone) {
      liveClone.style.setProperty('--print-accent', accent);
      liveClone.style.setProperty('--print-accent-text', accentText);
    }
    printThemeSwatches.querySelectorAll('.swatch').forEach((s) => s.classList.remove('is-active'));
    swatch.classList.add('is-active');
  });

  let lastPreviewFilters = null;

  printModalPreviewBtn.addEventListener('click', () => {
    const filters = readPrintFilters();
    if (!filters) return;
    const list = buildPrintList(filters);
    renderScheduleInto(filters, list);
    lastPreviewFilters = filters;
    // Clone the freshly-rendered sheet into the on-screen preview modal.
    printPreviewContentEl.innerHTML = '';
    const clone = printScheduleEl.cloneNode(true);
    clone.removeAttribute('id');
    clone.classList.add('print-schedule--preview');
    clone.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
    printPreviewContentEl.appendChild(clone);
    closePrintModal();
    printPreviewOverlay.hidden = false;
  });

  function closePrintPreview() {
    printPreviewOverlay.hidden = true;
  }
  printPreviewCloseBtn.addEventListener('click', closePrintPreview);
  printPreviewOverlay.addEventListener('click', (e) => {
    if (e.target === printPreviewOverlay) closePrintPreview();
  });
  printPreviewBackBtn.addEventListener('click', () => {
    closePrintPreview();
    openPrintModal();
  });
  printPreviewImageBtn.addEventListener('click', () => {
    const target = printPreviewContentEl.querySelector('.print-schedule--preview');
    if (!target) return;
    exportScheduleAsImage(target, lastPreviewFilters, printPreviewImageBtn);
  });
  printPreviewPrintBtn.addEventListener('click', () => {
    logActivity('Print Schedule', null, lastPreviewFilters ? { from: lastPreviewFilters.fromIso, to: lastPreviewFilters.toIso } : {});
    triggerPrint(); // modal closes once the task actually finishes (see triggerPrint below)
  });

  /* Print/print-preview popups (desktop and mobile alike) now close only
     once the print task has actually completed, rather than the moment
     printing starts — the browser's native print/share sheet handles the
     in-between.

     'afterprint' is the primary signal, but it isn't reliable everywhere:
     older Safari can be inconsistent, and in-app WebViews (WhatsApp,
     Instagram, Facebook's in-app browser) frequently skip it entirely.
     Without a fallback, the popup could get stuck open indefinitely on
     those browsers. So this also watches the print media query directly,
     and — as a last resort — force-closes shortly after print is
     triggered if neither signal has fired by then. */
  function closeAnyOpenPrintPopup() {
    if (!printModalOverlay.hidden) closePrintModal();
    if (!printPreviewOverlay.hidden) closePrintPreview();
  }
  window.addEventListener('afterprint', closeAnyOpenPrintPopup);
  if (window.matchMedia) {
    const printMq = window.matchMedia('print');
    const handlePrintMqChange = (e) => { if (!e.matches) closeAnyOpenPrintPopup(); };
    if (printMq.addEventListener) printMq.addEventListener('change', handlePrintMqChange);
    else if (printMq.addListener) printMq.addListener(handlePrintMqChange); // older Safari
  }

  function triggerPrint() {
    window.print();
    // Safety net for browsers/WebViews that never fire 'afterprint' or a
    // matching media-query change at all. closeAnyOpenPrintPopup() is a
    // no-op if the popup already closed, so this is harmless either way.
    setTimeout(closeAnyOpenPrintPopup, 3000);
  }

  /* ======================================================================
     PATIENTS TAB
     There is no separate patient database — a "patient" is derived by
     grouping appointment records by mobile number (the one field that
     reliably identifies the same person across visits). Next/Last
     Appointment are computed live from that patient's appointments, so
     they're always current with no extra data to keep in sync.
     ====================================================================== */

  const patientSearchInput = document.getElementById('patientSearchInput');
  const patientsListEl = document.getElementById('patientsList');
  const patientsEmptyEl = document.getElementById('patientsEmpty');
  const patientsCountEl = document.getElementById('patientsCount');

  /** Groups all appointments by mobile number and computes each patient's
   *  nearest upcoming appointment (excluding cancelled/completed) and most
   *  recent past appointment. */
  function derivePatients() {
    const now = new Date();
    const nowKey = `${isoDate(now)} ${pad(now.getHours())}:${pad(now.getMinutes())}`;

    const byMobile = new Map();
    DataStore.getAll().forEach((a) => {
      const key = (a.mobile || '').trim();
      if (!key) return; // skip malformed records with no mobile number
      if (!byMobile.has(key)) byMobile.set(key, []);
      byMobile.get(key).push(a);
    });

    const patients = [];
    byMobile.forEach((appts, mobile) => {
      // Use the most recently touched record for display name/title, in
      // case a name was corrected on a later visit.
      const latest = appts.slice().sort((a, b) =>
        (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || '')
      )[0];

      const upcoming = appts
        .filter((a) => {
          const status = a.status || 'scheduled';
          return status !== 'cancelled' && status !== 'completed' && `${a.date} ${a.time}` >= nowKey;
        })
        .sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));

      const past = appts
        .filter((a) => `${a.date} ${a.time}` < nowKey)
        .sort((a, b) => `${b.date} ${b.time}`.localeCompare(`${a.date} ${a.time}`));

      patients.push({
        mobile,
        name: latest.name,
        title: latest.title,
        nextAppt: upcoming[0] || null,
        lastAppt: past[0] || null,
        appointmentCount: appts.length
      });
    });

    patients.sort((a, b) => a.name.localeCompare(b.name));
    return patients;
  }

  /** Builds one action button (used for both the condensed row and the
   *  expanded grid) so the two stay behaviourally identical. */
  function buildPatientActionBtn({ icon, label, variant, onClick, disabled, expanded }) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `patient-action patient-action--${variant}`;
    btn.innerHTML = `<span class="material-symbols-rounded">${icon}</span><span>${escapeHtml(label)}</span>`;
    if (disabled) {
      btn.disabled = true;
    } else {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        onClick();
      });
    }
    return btn;
  }

  /** Wraps a single appointment record in a patient-shaped object so
   *  renderPatientCard can render individual appointments (Day Detail
   *  modal, Patient History modal) with the same look and actions as the
   *  Patients tab, instead of the old appt-card format. */
  function apptAsPatient(appt) {
    return { title: appt.title, name: appt.name, mobile: appt.mobile, nextAppt: appt, lastAppt: null };
  }

  function renderPatientCard(patient, opts) {
    opts = opts || {};
    const hasNext = !!patient.nextAppt;
    const editTarget = patient.nextAppt || patient.lastAppt;
    const isToday = hasNext && patient.nextAppt.date === isoDate(dateOffset(0));
    const isCancelled = hasNext && (patient.nextAppt.status || 'scheduled') === 'cancelled';

    const card = document.createElement('div');
    card.className = 'patient-card';

    /* ---------- Header: avatar, name, type/today chips, time + phone ---------- */
    const header = document.createElement('div');
    header.className = 'patient-card__header';

    const avatar = document.createElement('span');
    avatar.className = 'patient-card__avatar';
    avatar.textContent = initialsFor(patient.name);

    const info = document.createElement('div');
    info.className = 'patient-card__info';

    const nameRow = document.createElement('div');
    nameRow.className = 'patient-card__name-row';
    const nameSpan = document.createElement('span');
    nameSpan.className = 'patient-card__name';
    nameSpan.textContent = `${patient.title} ${patient.name}`;
    nameRow.appendChild(nameSpan);

    if (hasNext) {
      const meta = TYPE_META[patient.nextAppt.type] || TYPE_META.counselling;
      const typeChip = document.createElement('span');
      typeChip.className = `chip chip--${meta.color}`;
      typeChip.textContent = meta.label;
      nameRow.appendChild(typeChip);

      if (isToday) {
        const todayChip = document.createElement('span');
        todayChip.className = 'chip chip--today';
        todayChip.textContent = 'Today';
        nameRow.appendChild(todayChip);
      }
    }
    info.appendChild(nameRow);

    const metaRow = document.createElement('span');
    metaRow.className = 'patient-card__meta';
    let metaHtml = '';
    if (hasNext) {
      metaHtml += `<span><span class="material-symbols-rounded">schedule</span>${formatTime12h(patient.nextAppt.time)}</span>`;
    }
    metaHtml += `<span><span class="material-symbols-rounded">phone</span>${escapeHtml(patient.mobile)}</span>`;
    if (opts.showDate && hasNext) {
      metaHtml += `<span><span class="material-symbols-rounded">event</span>${formatDateInputValue(patient.nextAppt.date)}</span>`;
    }
    metaRow.innerHTML = metaHtml;
    info.appendChild(metaRow);

    const nextLabel = opts.nextLabel || 'Next Appointment';
    const nextEl = document.createElement('span');
    if (hasNext) {
      nextEl.className = 'patient-card__next patient-card__next--scheduled';
      nextEl.textContent = `${nextLabel}: ${formatDateInputValue(patient.nextAppt.date)}, ${formatTime12h(patient.nextAppt.time)}`;
    } else {
      nextEl.className = 'patient-card__next patient-card__next--none';
      nextEl.textContent = `${nextLabel}: Not Scheduled`;
    }
    info.appendChild(nextEl);

    if (hasNext && patient.nextAppt.notes) {
      const notesEl = document.createElement('span');
      notesEl.className = 'appt-card__notes';
      notesEl.textContent = '📝 ' + patient.nextAppt.notes;
      info.appendChild(notesEl);
    }

    if (isCancelled && patient.nextAppt.cancellationReason) {
      const reasonEl = document.createElement('span');
      reasonEl.className = 'appt-card__status-note';
      reasonEl.innerHTML = '<span class="material-symbols-rounded">event_busy</span>Reason: ' + escapeHtml(patient.nextAppt.cancellationReason);
      info.appendChild(reasonEl);
    }
    if (hasNext && patient.nextAppt.status === 'rescheduled' && Array.isArray(patient.nextAppt.history) && patient.nextAppt.history.length > 0) {
      const prev = patient.nextAppt.history[patient.nextAppt.history.length - 1];
      const rescheduleEl = document.createElement('span');
      rescheduleEl.className = 'appt-card__status-note';
      rescheduleEl.innerHTML =
        '<span class="material-symbols-rounded">event_repeat</span>Rescheduled from ' +
        formatDateInputValue(prev.date) + ' · ' + formatTime12h(prev.time);
      info.appendChild(rescheduleEl);
    }

    header.appendChild(avatar);
    header.appendChild(info);
    card.appendChild(header);

    /* ---------- Shared action handlers ---------- */
    const doNextAppointment = () => {
      closeAllActionPopups();
      if (hasNext) {
        openApptModal({ mode: 'edit', appt: patient.nextAppt });
      } else {
        openApptModal({ mode: 'add', prefill: { name: patient.name, mobile: patient.mobile } });
      }
    };
    const doViewAppointments = () => openPatientHistoryModal(patient);
    const doReschedule = () => {
      if (!hasNext) { showToast('No upcoming appointment to reschedule.'); return; }
      closeAllActionPopups();
      openRescheduleModal(patient.nextAppt);
    };
    const doSendReminder = () => {
      if (!hasNext) { showToast('No upcoming appointment to remind about.'); return; }
      openSendReminderModal(patient.nextAppt);
    };
    const doEdit = () => {
      closeAllActionPopups();
      openApptModal({ mode: 'edit', appt: editTarget });
    };
    const doCall = () => {
      closeAllActionPopups();
      window.open(`tel:${patient.mobile}`, '_self');
    };
    const doCancel = () => {
      if (!hasNext) { showToast('No upcoming appointment to cancel.'); return; }
      cancelPatientAppointment(patient.nextAppt);
    };

    /* ---------- Action row ---------- */
    const actions = document.createElement('div');
    actions.className = 'patient-actions';
    actions.appendChild(buildPatientActionBtn({ icon: 'call', label: 'Call', variant: 'call', onClick: doCall }));
    actions.appendChild(buildPatientActionBtn({ icon: 'event_upcoming', label: hasNext ? 'Next Appt' : 'Schedule', variant: 'next', onClick: doNextAppointment }));
    actions.appendChild(buildPatientActionBtn({ icon: 'list_alt', label: 'History', variant: 'view', onClick: doViewAppointments }));
    actions.appendChild(buildPatientActionBtn({ icon: 'event_repeat', label: 'Reschedule', variant: 'reschedule', onClick: doReschedule, disabled: !hasNext || isCancelled }));
    actions.appendChild(buildPatientActionBtn({ icon: 'notifications', label: 'Remind', variant: 'reminder', onClick: doSendReminder, disabled: !hasNext }));
    actions.appendChild(buildPatientActionBtn({ icon: 'edit', label: 'Edit', variant: 'edit', onClick: doEdit }));
    actions.appendChild(buildPatientActionBtn({ icon: 'event_busy', label: 'Cancel', variant: 'cancel', onClick: doCancel, disabled: !hasNext || isCancelled }));
    card.appendChild(actions);

    return card;
  }

  function renderPatientsList() {
    const query = patientSearchInput.value.trim().toLowerCase();
    let patients = derivePatients();
    if (query) {
      patients = patients.filter((p) =>
        p.name.toLowerCase().includes(query) || p.mobile.includes(query)
      );
    }

    patientsCountEl.textContent = `${patients.length} patient${patients.length === 1 ? '' : 's'}`;
    patientsListEl.innerHTML = '';
    if (patients.length === 0) {
      patientsEmptyEl.hidden = false;
    } else {
      patientsEmptyEl.hidden = true;
      patients.forEach((p) => patientsListEl.appendChild(renderPatientCard(p)));
    }
  }

  patientSearchInput.addEventListener('input', renderPatientsList);

  /* ======================================================================
     GLOBAL REFRESH
     ====================================================================== */

  function refreshEverything() {
    renderCalendar();
    renderReminderLists();
    renderAllAppointments();
    renderPatientsList();
    updateStats();
  }

  /* ======================================================================
     AUTH — profile menu, logout, header clock/session wiring
     ====================================================================== */

  const profileEmailEl = document.getElementById('profileEmail');
  const logoutBtn = document.getElementById('logoutBtn');
  const bootOverlay = document.getElementById('bootOverlay');
  const bootStatusEl = document.getElementById('bootStatus');

  function hideBootOverlay() {
    if (!bootOverlay) return;
    bootOverlay.classList.add('boot-overlay--hidden');
    setTimeout(() => { bootOverlay.hidden = true; }, 300);
  }

  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      logActivity('Logout', null);
      try {
        await signOutUser();
      } finally {
        window.location.href = 'login.html';
      }
    });
  }

  /* ======================================================================
     INIT
     Waits for an authenticated session (redirects to login.html if there
     isn't one), then starts the real-time Firestore listener before the
     first render — so every screen is populated with real data from the
     very first paint instead of flashing empty, and stays live afterwards
     with no page refresh ever required.
     ====================================================================== */

  async function init() {
    const user = await requireAuth(); // redirects to login.html if signed out
    if (profileEmailEl) profileEmailEl.textContent = user.email || '';

    setErrorHandler((err, context) => {
      const offline = err && (err.code === 'unavailable' || !navigator.onLine);
      if (offline) {
        showToast(`You're offline — showing the last synced data. Changes will sync automatically once you're back online.`);
      } else if (err && err.code === 'permission-denied') {
        showToast('Your session has expired. Please sign in again.');
        signOutUser().finally(() => { window.location.href = 'login.html'; });
      } else {
        showToast(`Couldn't ${context}. Please try again.`);
      }
    });

    // Any change to Firestore data — including real-time updates made from
    // another device/tab — re-renders the calendar, dashboard, reminder
    // lists, and (if open) the Day Detail popup. No page refresh needed.
    DataStore.onChange(() => {
      refreshEverything();
      if (!dayModalOverlay.hidden) renderDayModalList();
    });

    if (bootStatusEl) bootStatusEl.textContent = 'Connecting to Firestore…';
    try {
      await DataStore.start();
    } catch (err) {
      console.error('Initial Firestore load failed:', err);
      if (bootStatusEl) bootStatusEl.textContent = "Couldn't connect — retrying in the background…";
    }

    initReminderDateLabels();
    refreshEverything();
    updateHeaderClock();
    setInterval(updateHeaderClock, 1000 * 30);

    // Re-checks "starting soon" highlights and Today/Tomorrow buckets
    // periodically so the dashboard stays accurate if left open.
    setInterval(refreshEverything, 1000 * 60);

    hideBootOverlay();
  }

  document.addEventListener('DOMContentLoaded', init);
