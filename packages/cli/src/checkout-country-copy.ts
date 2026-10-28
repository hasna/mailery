const countryCopy = {
  en: {
    orderCommand: "Read the exact order and both checkout statements before payment",
    confirmCommand: "Confirm only after the person separately selects BOTH exact checkout statements. Prefer the browser order page.",
    startOption: "The person explicitly requests immediate performance during the 14-day withdrawal period",
    withdrawalOption: "The person separately acknowledges the exact withdrawal statement",
    languageOption: "Statement language (en or ro)",
    immediateVersionOption: "Exact immediate-performance statement version",
    withdrawalVersionOption: "Exact withdrawal statement version",
    confirmationKeyOption: "Retain this key for confirmation retries",
    choicesRequired: "Both separate explicit choices are required. No consent is inferred from purchase or Terms.",

    restrictions: "Paid checkout unavailable in:", review: "Review", free: "Signup and free use remain available.",
    policyRequired: "Retain the version from mailery billing countries and pass --country-policy-version for this purchase and every retry", policyOption: "Exact original policy version from billing countries. Keep it unchanged on every retry", legacyOption: "Replay an exact purchase from before country declarations. Cannot start a new purchase", legacyConflict: "--replay-legacy cannot be combined with country declaration options",
    required: "Declare --country <ISO-code> after reviewing the country restrictions", basisError: "--country-basis must be billing or residence",
    countryOption: "Your declared ISO billing or residence country, after reviewing /checkout", basisOption: "billing or residence", command: "Show current paid-checkout country restrictions before a purchase",
  },
  ro: {
    orderCommand: "Citește comanda exactă și ambele declarații înainte de plată",
    confirmCommand: "Confirmă numai după ce persoana bifează separat ambele declarații exacte. Folosește de preferat pagina comenzii.",
    startOption: "Persoana cere expres începerea serviciului în perioada de retragere de 14 zile",
    withdrawalOption: "Persoana confirmă separat declarația exactă privind retragerea",
    languageOption: "Limba declarațiilor (en sau ro)",
    immediateVersionOption: "Versiunea exactă a cererii de începere imediată",
    withdrawalVersionOption: "Versiunea exactă a declarației privind retragerea",
    confirmationKeyOption: "Păstrează această cheie la reîncercarea confirmării",
    choicesRequired: "Sunt necesare ambele alegeri exprese separate. Achiziția sau acceptarea termenilor nu le înlocuiesc.",

    restrictions: "Plata nu este disponibilă în:", review: "Consultă", free: "Înregistrarea și utilizarea gratuită rămân disponibile.",
    policyRequired: "Păstrează versiunea din mailery billing countries și transmite --country-policy-version pentru achiziție și fiecare reîncercare", policyOption: "Versiunea inițială exactă din billing countries. Păstreaz-o la fiecare reîncercare", legacyOption: "Reia o achiziție exactă anterioară declarațiilor de țară. Nu începe o achiziție nouă", legacyConflict: "--replay-legacy nu se combină cu opțiunile declarației de țară",
    required: "Declară --country <cod-ISO> după consultarea restricțiilor", basisError: "--country-basis trebuie să fie billing sau residence",
    countryOption: "Țara ISO de facturare sau reședință declarată, după consultarea /checkout", basisOption: "billing (facturare) sau residence (reședință)", command: "Afișează restricțiile de țară înainte de o achiziție",
  },
} as const;
export function checkoutCountryCopy(env: Record<string, string | undefined>) {
  const language = env.MAILERY_LANGUAGE ?? env.LC_ALL ?? env.LC_MESSAGES ?? env.LANG;
  return countryCopy[language?.toLowerCase().startsWith("ro") ? "ro" : "en"];
}
