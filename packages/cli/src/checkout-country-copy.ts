export type DisplayLanguage = "en" | "ro";

export function displayLanguage(env: Record<string, string | undefined>, saved?: DisplayLanguage): DisplayLanguage {
  const selected = env.MAILERY_LANGUAGE || saved || env.LC_ALL || env.LC_MESSAGES || env.LANG;
  return /^ro(?:[_-]|$)/i.test(selected ?? "") ? "ro" : "en";
}

const countryCopy = {
  en: {
    jsonOption: "Emit a machine-readable JSON envelope", helpOption: "Display help for command", usage: "Usage:", optionsPlaceholder: "[options]", options: "Options:", arguments: "Arguments:", defaultLabel: "default:", error: "error:", hint: "hint:",
    languageCommand: "Show or save the display language (en or ro); API language flags are separate", languageSaved: "Display language saved:", languageCurrent: "Display language:", languageInvalid: "language must be en or ro", preferencesRead: "Cannot read the language preference. No request was sent.", preferencesInvalid: "Invalid language preference. No request was sent. Restore a valid language-only preference file.", preferencesWrite: "Could not verify the saved language preference. No request was sent. Check the preference file before retrying.", preferencesPath: "An absolute HOME, HASNA_HOME or HASNA_CONFIG_HOME is required for language preferences.",
    purchasesCommand: "List your account's completed purchases and withdrawal status (owner session)", pageOption: "Page size, 1–100", cursorOption: "Continue from next_cursor", withdrawalPeriod: "withdrawal period:",
    withdrawCommand: "Identify a purchase for withdrawal. Does not confirm or refund it", emailOption: "Your signed-in account email for the acknowledgement", requestKeyOption: "Stable request key, retained on retries", acknowledgementLanguageOption: "Acknowledgement language: en or ro (separate from display language)",
    confirmWithdrawalCommand: "Confirm withdrawal of the purchase you reviewed. Refund remains pending policy execution", purchaseOption: "Exact purchase from the identified request", confirmKeyOption: "Stable confirmation key", yesOption: "Confirm withdrawal after the customer reviewed the purchase and email", withdrawalRequired: "review the identified purchase and use --yes to confirm withdrawal", withdrawalCommand: "Read withdrawal request, acknowledgement and refund status", requestLabel: "request:", purchaseLabel: "purchase:", acknowledgementLabel: "acknowledgement:", refundLabel: "refund:",
    sessionRequired: "this operation requires a session token (signup/login first)", sessionHint: "Run `mailery login --email <you> --password <pw>` first.", protocolInputRequired: "The current order protocol, exact version and stable confirmation key are required. Terms acceptance happens on Stripe, not through this request.",
    protocolOption: "Exact protocol from billing order", termsVersionOption: "Exact payment-page Terms intent version from billing order", protocolRequired: "Read the current order protocol and version before continuing to Stripe",
    subscribeCommand: "Start a subscription (plan: pro or scale): review the order, then continue to Stripe", noWaitOption: "Print the checkout URL and exit without polling for entitlement", purchaseKeyOption: "Stable purchase key; reuse it after failure or timeout (a fresh key starts a deliberate new purchase)", resumeOption: "Only poll entitlement; do not open another Checkout session", timeoutOption: "Max seconds to wait for entitlement", intervalOption: "Entitlement poll interval in seconds", resumeConflict: "--resume only polls entitlement; use it without --no-wait or --idempotency-key", checkoutLabel: "Checkout URL:", waiting: "Waiting for entitlement", active: " active", timedOut: " timed out", entitlementActive: "Entitlement active. Balance:",
    completePayment: (plan: string) => `Complete payment in the browser; run \`mailery subscribe ${plan} --resume\` to poll without opening Checkout.`,
    entitlementTimeout: (seconds: string) => `entitlement not active within ${seconds}s`, entitlementHint: "Complete the Stripe Checkout in the browser, then run `mailery subscribe <plan> --resume` to resume polling without creating Checkout, or check `mailery billing status`.",
    topupYesOption: "Confirm the top-up may spend money (required; non-interactive)", topupKeyOption: "Caller-stable key so a retried top-up replays the same checkout instead of opening a second one", invalidAmount: (amount: string) => `"${amount}" is not a dollar amount; pass e.g. 25 or 25.00`, presets: "Presets: 10, 25, 50, 100.", topupMinimum: "the minimum wallet top-up is $10.00", topupRequired: (amount: string) => `adding ${amount} to the prepaid wallet requires --yes`, topupHint: (amount: string, key: string) => `Run \`mailery billing add-funds ${amount} --yes --idempotency-key ${key}\`.`, topupKeyRequired: "--idempotency-key is required for a wallet top-up", topupRetry: (key: string) => `Retry with --idempotency-key ${key}; keep that exact key for every retry of this top-up.`, topupStarted: (amount: string) => `Top-up of ${amount} started.`, topupPending: "Funds land in the wallet once the payment completes; check `mailery billing wallet`.",
    fundingCommand: "Wallet funding is unavailable at paid opening (wallet_funding_disabled); existing request replay is retained",
    requiredOption: "Required option:", missingArgument: "Required argument:", unknownOption: "Unknown option:", invalidUsage: "Invalid command arguments. Read --help.",

    orderCommand: "Read the exact order and payment-page Terms intent",
    confirmCommand: "Continue the exact order to Stripe. Terms acceptance happens on Stripe and applies only when payment succeeds.",
    languageOption: "Order review language (en or ro)",
    confirmationKeyOption: "Retain this key for confirmation retries",

    restrictions: "Paid checkout unavailable in:", review: "Review", free: "Signup and free use remain available.",
    policyRequired: "Retain the version from mailery billing countries and pass --country-policy-version for this purchase and every retry", policyOption: "Exact original policy version from billing countries. Keep it unchanged on every retry", legacyOption: "Replay an exact purchase from before country declarations. Cannot start a new purchase", legacyConflict: "--replay-legacy cannot be combined with country declaration options",
    required: "Declare both --billing-country and --residence-country after reviewing the restrictions",
    billingCountryOption: "Your declared ISO billing country", residenceCountryOption: "Your declared ISO residence country", command: "Show current paid-checkout country restrictions before a purchase",
  },
  ro: {
    jsonOption: "Emite un rezultat JSON pentru prelucrare automată", helpOption: "Afișează instrucțiunile comenzii", usage: "Utilizare:", optionsPlaceholder: "[opțiuni]", options: "Opțiuni:", arguments: "Argumente:", defaultLabel: "implicit:", error: "eroare:", hint: "indiciu:",
    languageCommand: "Afișează sau salvează limba afișării (en sau ro); opțiunile de limbă API sunt separate", languageSaved: "Limba afișării a fost salvată:", languageCurrent: "Limba afișării:", languageInvalid: "limba trebuie să fie en sau ro", preferencesRead: "Preferința de limbă nu poate fi citită. Nu s-a trimis nicio cerere.", preferencesInvalid: "Preferința de limbă nu este validă. Nu s-a trimis nicio cerere. Restabilește un fișier valid care conține doar limba.", preferencesWrite: "Salvarea preferinței de limbă nu a putut fi verificată. Nu s-a trimis nicio cerere. Verifică fișierul înainte de reîncercare.", preferencesPath: "Preferința de limbă necesită o cale absolută HOME, HASNA_HOME sau HASNA_CONFIG_HOME.",
    purchasesCommand: "Afișează achizițiile încheiate și starea retragerii (sesiunea titularului)", pageOption: "Număr de rezultate pe pagină, 1–100", cursorOption: "Continuă de la next_cursor", withdrawalPeriod: "perioada de retragere:",
    withdrawCommand: "Identifică o achiziție pentru retragere. Nu confirmă și nu rambursează achiziția", emailOption: "Adresa contului autentificat pentru confirmarea prin email", requestKeyOption: "Cheia stabilă a cererii, păstrată la reîncercare", acknowledgementLanguageOption: "Limba confirmării prin email: en sau ro (separată de limba afișării)",
    confirmWithdrawalCommand: "Confirmă retragerea achiziției consultate. Rambursarea așteaptă aplicarea politicii", purchaseOption: "Achiziția exactă din cererea identificată", confirmKeyOption: "Cheia stabilă a confirmării", yesOption: "Confirmă retragerea după consultarea achiziției și a adresei de email", withdrawalRequired: "consultă achiziția identificată și folosește --yes pentru a confirma retragerea", withdrawalCommand: "Citește cererea de retragere, confirmarea prin email și starea rambursării", requestLabel: "cerere:", purchaseLabel: "achiziție:", acknowledgementLabel: "confirmare:", refundLabel: "rambursare:",
    sessionRequired: "această operațiune necesită o sesiune autentificată (înregistrează-te sau autentifică-te mai întâi)", sessionHint: "Rulează mai întâi `mailery login --email <you> --password <pw>`.", protocolInputRequired: "Sunt necesare protocolul comenzii curente, versiunea exactă și cheia stabilă a confirmării. Termenii se acceptă pe Stripe, nu prin această cerere.",
    protocolOption: "Protocolul exact din billing order", termsVersionOption: "Versiunea exactă a termenilor de pe pagina de plată din billing order", protocolRequired: "Citește protocolul și versiunea comenzii curente înainte de a continua pe Stripe",
    subscribeCommand: "Începe un abonament (plan: pro sau scale): consultă comanda, apoi continuă pe Stripe", noWaitOption: "Afișează adresa paginii de plată fără a aștepta activarea", purchaseKeyOption: "Cheia stabilă a achiziției; păstreaz-o după eșec sau expirarea timpului (o cheie nouă începe o achiziție nouă)", resumeOption: "Verifică doar activarea; nu deschide o altă sesiune Checkout", timeoutOption: "Numărul maxim de secunde de așteptare a activării", intervalOption: "Intervalul verificării activării, în secunde", resumeConflict: "--resume verifică doar activarea; folosește-l fără --no-wait sau --idempotency-key", checkoutLabel: "Adresa paginii de plată:", waiting: "Se așteaptă activarea", active: " activă", timedOut: " timpul a expirat", entitlementActive: "Acces activ. Sold:",
    completePayment: (plan: string) => `Finalizează plata în browser; rulează \`mailery subscribe ${plan} --resume\` pentru verificarea activării fără o altă sesiune Checkout.`,
    entitlementTimeout: (seconds: string) => `accesul nu s-a activat în ${seconds}s`, entitlementHint: "Finalizează plata pe Stripe în browser, apoi rulează `mailery subscribe <plan> --resume` pentru verificarea activării fără o altă sesiune Checkout sau consultă `mailery billing status`.",
    topupYesOption: "Confirmă că alimentarea poate cheltui bani (obligatoriu; fără interacțiune)", topupKeyOption: "Cheia stabilă a cererii pentru reluarea aceleiași plăți la reîncercare", invalidAmount: (amount: string) => `"${amount}" nu este o sumă în dolari; folosește, de exemplu, 25 sau 25.00`, presets: "Valori disponibile: 10, 25, 50, 100.", topupMinimum: "alimentarea minimă a portofelului este 10,00 USD", topupRequired: (amount: string) => `adăugarea sumei ${amount} în portofel necesită --yes`, topupHint: (amount: string, key: string) => `Rulează \`mailery billing add-funds ${amount} --yes --idempotency-key ${key}\`.`, topupKeyRequired: "--idempotency-key este obligatorie pentru alimentarea portofelului", topupRetry: (key: string) => `Reîncearcă cu --idempotency-key ${key}; păstrează cheia exactă la fiecare reîncercare a acestei alimentări.`, topupStarted: (amount: string) => `Alimentarea cu ${amount} a început.`, topupPending: "Suma intră în portofel după finalizarea plății; verifică `mailery billing wallet`.",
    fundingCommand: "Alimentarea portofelului nu este disponibilă la lansarea plăților (wallet_funding_disabled); reluarea cererilor existente este păstrată",
    requiredOption: "Opțiune obligatorie:", missingArgument: "Argument obligatoriu:", unknownOption: "Opțiune necunoscută:", invalidUsage: "Argumentele comenzii nu sunt valide. Consultă --help.",

    orderCommand: "Citește comanda și termenii prezentați pe pagina de plată",
    confirmCommand: "Continuă comanda pe Stripe. Acceptarea termenilor are loc pe Stripe și se aplică după reușita plății.",
    languageOption: "Limba declarațiilor (en sau ro)",
    confirmationKeyOption: "Păstrează această cheie la reîncercarea confirmării",

    restrictions: "Plata nu este disponibilă în:", review: "Consultă", free: "Înregistrarea și utilizarea gratuită rămân disponibile.",
    policyRequired: "Păstrează versiunea din mailery billing countries și transmite --country-policy-version pentru achiziție și fiecare reîncercare", policyOption: "Versiunea inițială exactă din billing countries. Păstreaz-o la fiecare reîncercare", legacyOption: "Reia o achiziție exactă anterioară declarațiilor de țară. Nu începe o achiziție nouă", legacyConflict: "--replay-legacy nu se combină cu opțiunile declarației de țară",
    required: "Declară atât --billing-country, cât și --residence-country după consultarea restricțiilor",
    billingCountryOption: "Țara ISO de facturare declarată", residenceCountryOption: "Țara ISO de reședință declarată", command: "Afișează restricțiile de țară înainte de o achiziție",
  },
} as const;
export function checkoutCountryCopy(env: Record<string, string | undefined>) {
  return countryCopy[displayLanguage(env)];
}

export function displayNumber(value: number, language: DisplayLanguage): string {
  return new Intl.NumberFormat(language === "ro" ? "ro-RO" : "en-US").format(value);
}

export function displayUsdCents(cents: number, language: DisplayLanguage): string {
  return language === "en" ? `$${(cents / 100).toFixed(2)}` : new Intl.NumberFormat("ro-RO", { style: "currency", currency: "USD" }).format(cents / 100);
}
