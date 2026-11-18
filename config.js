// =====================================================================
//  Vul hier de gegevens van jouw Supabase-project in (zie LEESMIJ.md).
//  Te vinden in Supabase → Project Settings → API Keys / Data API.
//  Zolang hier "VUL_IN" staat, draait de app in DEMOMODUS met nepdata.
// =====================================================================
export const SUPABASE_URL = "https://eazujazhawvjjthrydlu.supabase.co";            // bijv. https://abcdefgh.supabase.co
export const SUPABASE_KEY = "sb_publishable_cCmou4G9lCW6dpEbNbPhig_8Ji_RxxO";            // de publishable key (sb_publishable_...)

export const DEMO = SUPABASE_URL.includes("VUL_IN") || SUPABASE_KEY.includes("VUL_IN");
