import { createContext, useContext } from "react";
import { DEFAULT_LANG, makeT } from "./i18n";
import type { Lang, TFn } from "./i18n";

// React bindings live apart from i18n.ts so server code importing the dictionary stays React-free.
export const LangContext = createContext<Lang>(DEFAULT_LANG);
export const useLang = () => useContext(LangContext);
export const useT = (): TFn => makeT(useContext(LangContext));
