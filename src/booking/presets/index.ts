export interface BookingPreset {
  name: string;
  mode: "embed" | "link";
  /**
   * Example embed code: always an <iframe> of the provider's booking page, never a <script>
   * (src/booking/embed.ts, security review M1). Absent where the provider's iframe address
   * isn't known here: paste the iframe code from the provider's own embed settings.
   */
  embedPattern?: string;
  urlPattern?: string;
  requiresConsent: boolean;
  /**
   * The origins an embed may frame. A page's CSP allows these, and only these, as frames when
   * the site's embed code uses this provider (src/booking/embed.ts).
   */
  origins: string[];
  docs: string;
}

const presets: Record<string, BookingPreset> = {
  waiteraid: {
    name: "WaiterAid / BokaBord",
    mode: "embed",
    requiresConsent: true,
    origins: ["https://app.waiteraid.com"],
    docs: "https://waiteraid.com",
  },
  thefork: {
    name: "TheFork",
    mode: "embed",
    embedPattern: `<iframe src="https://widget.thefork.com/RESTAURANT_UUID" style="width:100%;min-height:800px;border:none;" allow="payment *"></iframe>`,
    requiresConsent: true,
    origins: ["https://widget.thefork.com"],
    docs: "https://www.thefork.com",
  },
  formitable: {
    name: "Formitable",
    mode: "embed",
    requiresConsent: true,
    origins: ["https://www.formitable.com"],
    docs: "https://formitable.com",
  },
  easytable: {
    name: "easyTable",
    mode: "embed",
    embedPattern: `<iframe src="https://book.easytable.com/book/?id=RESTAURANT_ID" title="Boka bord" style="width:100%;min-height:800px;border:none;"></iframe>`,
    urlPattern: "https://book.easytable.com/book/?id=RESTAURANT_ID",
    requiresConsent: true,
    origins: ["https://book.easytable.com"],
    docs: "https://easytablebooking.com",
  },
  quandoo: {
    name: "Quandoo",
    mode: "embed",
    requiresConsent: true,
    origins: ["https://booking-widget.quandoo.com"],
    docs: "https://www.quandoo.com",
  },
  bokabord: {
    name: "BokaBord.se",
    mode: "link",
    urlPattern: "https://bokabord.se/RESTAURANT_SLUG",
    requiresConsent: false,
    origins: [],
    docs: "https://bokabord.se",
  },
};

export function getPreset(id: string): BookingPreset | undefined {
  return Object.hasOwn(presets, id) ? presets[id] : undefined;
}

export function listPresets(): Record<string, BookingPreset> {
  return presets;
}
