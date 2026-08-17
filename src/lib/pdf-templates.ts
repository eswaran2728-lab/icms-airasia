import "server-only";

import path from "node:path";

export type OfficialFormKind = "INBOUND" | "OUTBOUND" | "VENDOR";

/**
 * Maps a transaction category to its official source PDF. INBOUND and
 * OUTBOUND are two pages of the same official IFCSF file (AA/SEC/F/010
 * Rev.01); VENDOR is a separate official file (AA/SEC/F/019 Rev.01).
 * This is the one place that decides which physical form a transaction
 * gets — nothing else in the codebase should hardcode a template path.
 */
const TEMPLATE_PATH: Record<OfficialFormKind, string> = {
  OUTBOUND: "templates/forms/ifcsf/ifcsf-inbound-outbound.pdf",
  INBOUND: "templates/forms/ifcsf/ifcsf-inbound-outbound.pdf",
  VENDOR: "templates/forms/vendor/vendor-supplies-security-form.pdf",
};

/** 0-based page index to use within the selected PDF. */
const TEMPLATE_PAGE_INDEX: Record<OfficialFormKind, number> = {
  OUTBOUND: 0,
  INBOUND: 1,
  VENDOR: 0,
};

export function getOfficialFormTemplate(kind: OfficialFormKind): {
  absolutePath: string;
  pageIndex: number;
} {
  return {
    absolutePath: path.join(process.cwd(), TEMPLATE_PATH[kind]),
    pageIndex: TEMPLATE_PAGE_INDEX[kind],
  };
}
