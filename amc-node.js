#!/usr/bin/env node

/*
 * Mike's Odyssey IMAX 70mm watcher
 * AMC Lincoln Square 13
 *
 * Alerts only when TWO ADJACENT seats are available.
 *
 * Dates:
 *   Aug 17-18, 2026
 *   Aug 20-23, 2026
 *   Sep 9, 2026 and later
 *
 * Times:
 *   6:00 AM through 11:59 PM
 *
 * Seats:
 *   ANY row / ANY seat, as long as 2 are directly adjacent
 *
 * Notification:
 *   ntfy topic stored in GitHub secret NTFY_TOPIC
 */

const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");

puppeteer.use(StealthPlugin());

// ─────────────────────────────────────────────
// SETTINGS
// ─────────────────────────────────────────────

const THEATER_URL =
  "https://www.amctheatres.com/movie-theatres/new-york-city/amc-lincoln-square-13/showtimes";

const MOVIE = "the odyssey";

// No overnight / 2 AM screenings
const MIN_SHOWTIME_MINUTES = 6 * 60;      // 6:00 AM
const MAX_SHOWTIME_MINUTES = 24 * 60;     // midnight

// Your private ntfy topic will be stored as a GitHub secret later
const NTFY_TOPIC = process.env.NTFY_TOPIC;

// Small delay so we don't hammer AMC
const PAGE_DELAY_MS = 2500;
const BETWEEN_SHOWS_DELAY_MS = 1500;

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(message) {
  console.log(`[${new Date().toLocaleString()}] ${message}`);
}

function isWantedDate(date) {
  // date format: YYYY-MM-DD

  // Aug 17-18
  if (date >= "2026-08-17" && date <= "2026-08-18") {
    return true;
  }

  // Aug 20-23
  if (date >= "2026-08-20" && date <= "2026-08-23") {
    return true;
  }

  // Sep 9 onward
  if (date >= "2026-09-09" && date <= "2026-09-16") {
    return true;
  }

  return false;
}

function parseShowtimeMinutes(timeText) {
  const match = timeText
    .trim()
    .match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/i);

  if (!match) return null;

  let hour = parseInt(match[1], 10);
  const minute = parseInt(match[2], 10);
  const ampm = match[3].toLowerCase();

  if (ampm === "pm" && hour !== 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;

  return hour * 60 + minute;
}

function findAdjacentPairs(seats) {
  /*
   * Example:
   * ["H18", "H19", "H22"]
   * becomes:
   * [["H18", "H19"]]
   */

  const parsed = seats
    .map((seat) => {
      const match = seat.match(/^([A-Z]+)(\d+)$/);
      if (!match) return null;

      return {
        label: seat,
        row: match[1],
        number: parseInt(match[2], 10),
      };
    })
    .filter(Boolean);

  const byRow = {};

  for (const seat of parsed) {
    if (!byRow[seat.row]) {
      byRow[seat.row] = [];
    }
    byRow[seat.row].push(seat);
  }

  const pairs = [];

  for (const row of Object.keys(byRow)) {
    const rowSeats = byRow[row].sort((a, b) => a.number - b.number);

    for (let i = 0; i < rowSeats.length - 1; i++) {
      const current = rowSeats[i];
      const next = rowSeats[i + 1];

      if (next.number === current.number + 1) {
        pairs.push([current.label, next.label]);
      }
    }
  }

  return pairs;
}

async function sendNtfy(title, message, bookingUrl) {
  if (!NTFY_TOPIC) {
    log("NTFY_TOPIC not configured yet — skipping notification.");
    return;
  }

  try {
    const response = await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method: "POST",
      headers: {
        Title: title,
        Priority: "urgent",
        Tags: "movie_camera,ticket",
        Click: bookingUrl,
      },
      body: message,
    });

    if (!response.ok) {
      throw new Error(`ntfy returned ${response.status}`);
    }

    log("ntfy notification sent.");
  } catch (error) {
    log(`ntfy notification failed: ${error.message}`);
  }
}

// ─────────────────────────────────────────────
// AMC SCRAPING
// ─────────────────────────────────────────────

async function getAvailableDates(page) {
  await page.goto(THEATER_URL, {
    waitUntil: "networkidle2",
    timeout: 60000,
  });

  await sleep(PAGE_DELAY_MS);

  return page.evaluate(() => {
    const options = document.querySelectorAll(
      'select[name="date"] option'
    );

    return Array.from(options)
      .map((option) => option.value)
      .filter((value) =>
        /^\d{4}-\d{2}-\d{2}$/.test(value)
      );
  });
}

async function getShowtimes(page, date) {
  const url = `${THEATER_URL}?date=${date}`;

  await page.goto(url, {
    waitUntil: "networkidle2",
    timeout: 60000,
  });

  await sleep(PAGE_DELAY_MS);

  return page.evaluate((movieTerm) => {
    const links = document.querySelectorAll(
      "a[href*='/showtimes/']"
    );

    const results = [];

    for (const link of links) {
      const href = link.href;

      const idMatch = href.match(/\/showtimes\/(\d+)/);
      if (!idMatch) continue;

      const section = link.closest("section");
      const movieHeading = section?.querySelector("h1");

      const movieName = movieHeading
        ? movieHeading.innerText.trim()
        : "";

      if (
        !movieName
          .toLowerCase()
          .includes(movieTerm.toLowerCase())
      ) {
        continue;
      }

      const formatContainer =
        link.closest("ul")?.closest("li");

      const formatText =
        formatContainer?.innerText || "";

      if (!formatText.includes("IMAX 70MM")) {
        continue;
      }

      const timeText =
        link.innerText.trim().split("\n")[0];

      results.push({
        id: idMatch[1],
        movie: movieName,
        time: timeText,
      });
    }

    return results;
  }, MOVIE);
}

async function getAvailableSeats(page, showtimeId) {
  const url =
    `https://www.amctheatres.com/showtimes/${showtimeId}`;

  await page.goto(url, {
    waitUntil: "networkidle2",
    timeout: 60000,
  });

  await sleep(PAGE_DELAY_MS);

  return page.evaluate(() => {
    const inputs =
      document.querySelectorAll("input[aria-label]");

    const seats = [];

    for (const input of inputs) {
      const label =
        input.getAttribute("aria-label") || "";

      if (/occupied/i.test(label)) continue;
      if (/unavailable/i.test(label)) continue;
const label =
  input.getAttribute("aria-label") || "";

if (/occupied/i.test(label)) continue;
if (/unavailable/i.test(label)) continue;

// Ignore accessible / wheelchair / companion seating
if (/wheelchair/i.test(label)) continue;
if (/accessible/i.test(label)) continue;
if (/companion/i.test(label)) continue;

      // Captures seat labels like H18 or AA12
      const match =
        label.match(/([A-Z]+)\s*(\d+)\s*$/i);

      if (!match) continue;

      const row = match[1].toUpperCase();
      const number = parseInt(match[2], 10);

      seats.push(`${row}${number}`);
    }

    return [...new Set(seats)];
  });
}

// ─────────────────────────────────────────────
// MAIN SCAN
// ─────────────────────────────────────────────

async function runScan(page) {
  log("Starting Odyssey Lincoln Square pair scan.");

  const allDates = await getAvailableDates(page);

  const wantedDates =
    allDates.filter(isWantedDate);

  log(
    `AMC currently exposes ${wantedDates.length} wanted date(s): ` +
    wantedDates.join(", ")
  );

  let hits = 0;

  for (const date of wantedDates) {
    const showtimes =
      await getShowtimes(page, date);

    log(
      `${date}: ${showtimes.length} Odyssey IMAX 70mm showtime(s)`
    );

    for (const showtime of showtimes) {
      const minutes =
        parseShowtimeMinutes(showtime.time);

      if (minutes === null) {
        log(
          `${date} ${showtime.time}: couldn't parse time`
        );
        continue;
      }

      if (
        minutes < MIN_SHOWTIME_MINUTES ||
        minutes >= MAX_SHOWTIME_MINUTES
      ) {
        log(
          `${date} ${showtime.time}: overnight — skipping`
        );
        continue;
      }

      /*
       * IMPORTANT:
       * We intentionally check the seat map even if AMC's
       * theater page labels the show as sold out.
       *
       * That's exactly where cancellation seats can reappear.
       */

      const seats =
        await getAvailableSeats(page, showtime.id);

      const pairs =
        findAdjacentPairs(seats);

      if (pairs.length === 0) {
        log(
          `${date} ${showtime.time}: no adjacent pair`
        );
      } else {
        hits++;

        const pairText =
          pairs
            .map((pair) => pair.join(" + "))
            .join(", ");

        const bookingUrl =
          `https://www.amctheatres.com/showtimes/${showtime.id}`;

        log(
          `HIT: ${date} ${showtime.time} — ${pairText}`
        );

        await sendNtfy(
          "ODYSSEY PAIR FOUND",
          `${date} · ${showtime.time}\n${pairText}\nAMC Lincoln Square IMAX 70mm`,
          bookingUrl
        );
      }

      await sleep(
        BETWEEN_SHOWS_DELAY_MS +
        Math.random() * 1000
      );
    }
  }

  log(
    hits === 0
      ? "Scan finished — no adjacent pairs."
      : `Scan finished — ${hits} matching showtime(s)!`
  );
}

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────

async function main() {
  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
    ],
  });

  const page = await browser.newPage();

  try {
    await runScan(page);
  } catch (error) {
    log(
      `Scan error: ${error.stack || error.message}`
    );
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();