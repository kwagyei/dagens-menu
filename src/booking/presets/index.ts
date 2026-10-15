export interface BookingPreset {
  name: string;
  mode: "embed" | "link";
  embedPattern?: string;
  urlPattern?: string;
  docs: string;
}

const presets: Record<string, BookingPreset> = {
  bookatable: {
    name: "Book a Table",
    mode: "embed",
    embedPattern: `<iframe src="https://bookatable.com/widget/RESTAURANT_ID" style="width:100%;height:500px;border:none;"></iframe>`,
    docs: "https://bookatable.com",
  },
  thefork: {
    name: "TheFork (f.k.a. TripAdvisor)",
    mode: "embed",
    embedPattern: `<iframe src="https://module.thefork.com/RESTAURANT_ID" style="width:100%;height:500px;border:none;"></iframe>`,
    docs: "https://www.thefork.com",
  },
  formitable: {
    name: "Formitable",
    mode: "embed",
    embedPattern: `<iframe src="https://www.formitable.com/widget/RESTAURANT_ID" style="width:100%;height:600px;border:none;"></iframe>`,
    docs: "https://formitable.com",
  },
  bordet: {
    name: "Bordet.se",
    mode: "link",
    urlPattern: "https://bordet.se/RESTAURANT_ID",
    docs: "https://bordet.se",
  },
  dineroonline: {
    name: "DineroOnline",
    mode: "link",
    urlPattern: "https://www.dineroonline.se/RESTAURANT_ID",
    docs: "https://www.dineroonline.se",
  },
};

export function getPreset(id: string): BookingPreset | undefined {
  return presets[id];
}

export function listPresets(): Record<string, BookingPreset> {
  return presets;
}
