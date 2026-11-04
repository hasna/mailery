const countryCopy = {
  en: {
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
  const language = env.MAILERY_LANGUAGE ?? env.LC_ALL ?? env.LC_MESSAGES ?? env.LANG;
  return countryCopy[language?.toLowerCase().startsWith("ro") ? "ro" : "en"];
}
