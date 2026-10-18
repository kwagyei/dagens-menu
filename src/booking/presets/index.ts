export interface BookingPreset {
  name: string;
  mode: "embed" | "link";
  embedPattern?: string;
  urlPattern?: string;
  requiresConsent: boolean;
  /**
   * The origins an embed may load from. A page's CSP allows these, and only these, when the
   * site's embed code uses this provider (src/booking/embed.ts).
   */
  origins: string[];
  docs: string;
}

const presets: Record<string, BookingPreset> = {
  waiteraid: {
    name: "WaiterAid / BokaBord",
    mode: "embed",
    embedPattern: `<script src="https://app.waiteraid.com/widget/RESTAURANT_ID.js"></script>`,
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
    embedPattern: `<script src="https://www.formitable.com/sdk/v1.js"></script><div data-formitable-widget="RESTAURANT_ID"></div>`,
    requiresConsent: true,
    origins: ["https://www.formitable.com"],
    docs: "https://formitable.com",
  },
  easytable: {
    name: "easyTable",
    mode: "embed",
    embedPattern: `<script src="https://book.easytable.com/widget/RESTAURANT_ID.js"></script>`,
    urlPattern: "https://book.easytable.com/book/?id=RESTAURANT_ID",
    requiresConsent: true,
    origins: ["https://book.easytable.com"],
    docs: "https://easytablebooking.com",
  },
  quandoo: {
    name: "Quandoo",
    mode: "embed",
    embedPattern: `<script src="https://booking-widget.quandoo.com/index.js" data-merchant-id="RESTAURANT_ID" data-theme="light"></script>`,
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
