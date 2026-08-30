import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

type Ad = {
  id: string;
  url: string;
  text: string;
};

const searchUrl = Bun.env.LACENTRALE_SEARCH_URL;
console.log(`Recherche : ${searchUrl}`);
const stateFile = "data/seen.json";
const temporaryStateFile = `${stateFile}.tmp`;

if (!searchUrl) {
  throw new Error("LACENTRALE_SEARCH_URL est manquante");
}

async function loadSeen(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(stateFile, "utf8"));
  } catch {
    return {};
  }
}

async function notifyTelegram(ad: Ad): Promise<void> {
  const token = Bun.env.TELEGRAM_BOT_TOKEN;
  const chatId = Bun.env.TELEGRAM_CHAT_ID;

  const message = `🚗 Nouvelle annonce\n\n${ad.text}\n\n${ad.url}`;

  if (!token || !chatId) {
    console.log(message);
    return;
  }

  const response = await fetch(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`Erreur Telegram : ${response.status}`);
  }
}

await mkdir("data", { recursive: true });

const firstRun = !existsSync(stateFile);
const seen = await loadSeen();

const browser = await chromium.launchPersistentContext(
  ".browser-profile",
  {
    headless: true,
    locale: "fr-FR",
  },
);

try {
  const page = browser.pages()[0] ?? await browser.newPage();

  const response = await page.goto(searchUrl, {
    waitUntil: "domcontentloaded",
    timeout: 45_000,
  });

  if (!response?.ok()) {
    throw new Error(`La Centrale répond HTTP ${response?.status()}`);
  }

  const bodyText = await page.locator("body").innerText();

  if (/captcha|access blocked|activité inhabituelle/i.test(bodyText)) {
    throw new Error("Blocage ou CAPTCHA détecté : arrêt du scraper");
  }

  const ads: Ad[] = await page
    .locator('a[href*="/auto-occasion-annonce-"]')
    .evaluateAll((elements) => {
      const unique = new Map<string, Ad>();

      for (const element of elements) {
        const link = element as HTMLAnchorElement;
        const match = link.href.match(
          /auto-occasion-annonce-(\d+)\.html/,
        );

        if (!match) continue;

        const card = link.closest(
          "article, li, [class*='searchCard']",
        );

        unique.set(match[1], {
          id: match[1],
          url: link.href,
          text:
            card?.textContent
              ?.replace(/\s+/g, " ")
              .trim()
              .slice(0, 500) ?? "Nouvelle voiture",
        });
      }

      return [...unique.values()];
    });

  const newAds = ads.filter((ad) => !seen[ad.id]);
  const now = new Date().toISOString();

  for (const ad of ads) {
    seen[ad.id] ??= now;
  }

  await writeFile(
    temporaryStateFile,
    JSON.stringify(seen, null, 2),
  );
  await rename(temporaryStateFile, stateFile);

  if (firstRun) {
    console.log(
      `Initialisation : ${ads.length} annonces enregistrées sans notification.`,
    );
  } else {
    for (const ad of newAds.reverse()) {
      await notifyTelegram(ad);
    }

    console.log(`${newAds.length} nouvelle(s) annonce(s).`);
  }
} finally {
  await browser.close();
}