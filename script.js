// Import translations from separate files
import { en } from './locales/en.js';
import { fr } from './locales/fr.js';

// Combine translations
const translations = { en, fr };

const btnEn = document.getElementById("btn-en");
const btnFr = document.getElementById("btn-fr");

function setLang(lang) {
  document.documentElement.lang = lang;
  for (const [key, value] of Object.entries(translations[lang])) {
    document.querySelectorAll(`[data-i18n="${key}"]`).forEach(el => {
      // If the translation value is an array, create separate child elements
      if (Array.isArray(value)) {
        // Clear existing children
        el.innerHTML = '';
        value.forEach(itemHtml => {
          const p = document.createElement('p');
          p.innerHTML = itemHtml;
          el.appendChild(p);
        });
      } else {
        el.innerHTML = value;
      }
    });
  }
  btnEn.classList.toggle("active", lang === "en");
  btnFr.classList.toggle("active", lang === "fr");
  btnEn.setAttribute("aria-pressed", lang === "en");
  btnFr.setAttribute("aria-pressed", lang === "fr");
  localStorage.setItem("lang", lang);
}

/**
 * Detects user's preferred language from browser settings
 * Returns the best match from our available languages
 */
function detectUserLanguage() {
  // First check localStorage for previously set language
  const savedLang = localStorage.getItem("lang");
  if (savedLang && translations[savedLang]) {
    return savedLang;
  }
  
  // Try to get user's preferred languages from browser
  if (navigator.languages && navigator.languages.length) {
    // Go through the user's preferred languages in order
    for (const lang of navigator.languages) {
      // Match language codes like 'fr', 'fr-CA', 'fr-FR', etc.
      const baseLang = lang.split('-')[0].toLowerCase();
      if (translations[baseLang]) {
        return baseLang;
      }
    }
  }
  
  // Fallback to navigator.language
  if (navigator.language) {
    const baseLang = navigator.language.split('-')[0].toLowerCase();
    if (translations[baseLang]) {
      return baseLang;
    }
  }
  
  // Default fallback
  return "fr";
}

// Set initial language based on user preference
const userLanguage = detectUserLanguage();
setLang(userLanguage);

// Add event listeners for language toggles
btnEn.addEventListener("click", () => setLang("en"));
btnFr.addEventListener("click", () => setLang("fr"));

// Update language if the browser language changes (rare but possible)
window.addEventListener('languagechange', () => {
  // Only update if the user hasn't explicitly chosen a language
  if (!localStorage.getItem("lang")) {
    setLang(detectUserLanguage());
  }
});
