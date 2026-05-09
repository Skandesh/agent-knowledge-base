declare module "jsdom" {
  export class JSDOM {
    constructor(html?: string, options?: { url?: string });
    window: {
      document: Document;
    };
  }
}
