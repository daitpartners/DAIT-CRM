/** The part of sanitize-html (2.18, ships no types) that mail/html.ts uses; the second npm dependency is avoided. */
declare module 'sanitize-html' {
  function sanitizeHtml(dirty: string, options?: sanitizeHtml.Options): string;
  namespace sanitizeHtml {
    type Attributes = Record<string, string>;
    interface Frame {
      tag: string;
      attribs: Attributes;
      text: string;
    }
    interface Options {
      allowedTags?: string[];
      allowedAttributes?: Record<string, string[]>;
      allowedSchemes?: string[];
      allowedSchemesByTag?: Record<string, string[]>;
      allowProtocolRelative?: boolean;
      allowVulnerableTags?: boolean;
      nonTextTags?: string[];
      transformTags?: Record<string, (tagName: string, attribs: Attributes) => { tagName: string; attribs: Attributes }>;
      exclusiveFilter?: (frame: Frame) => boolean;
    }
    const defaults: { allowedTags: string[] };
  }
  export default sanitizeHtml;
}
