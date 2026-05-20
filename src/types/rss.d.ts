declare module "rss" {
  interface RSSOptions {
    title: string;
    description: string;
    feed_url: string;
    site_url: string;
    language?: string;
    image_url?: string;
    docs?: string;
    managingEditor?: string;
    webMaster?: string;
    copyright?: string;
    pubDate?: Date;
    ttl?: number;
    generator?: string;
    categories?: string[];
    custom_namespaces?: Record<string, string>;
    custom_elements?: any[];
  }

  interface RSSItemOptions {
    title: string;
    description: string;
    url: string;
    guid?: string;
    categories?: string[];
    author?: string;
    date?: Date;
    lat?: number;
    long?: number;
    enclosure?: {
      url: string;
      file?: string;
      size?: number;
      type?: string;
    };
    custom_elements?: any[];
  }

  interface RSSXMLOptions {
    indent?: boolean;
  }

  class RSS {
    constructor(options: RSSOptions);
    item(options: RSSItemOptions): void;
    xml(options?: RSSXMLOptions): string;
  }

  export = RSS;
}
