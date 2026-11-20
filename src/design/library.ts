/**
 * The section library: plain, accessible HTML using `mv-*` classes, styled by `sections.css` and the
 * project's `--mv-*` theme tokens. The website templates are built from the same sections, so a
 * section inserted visually looks at home in a template, and still works on an imported site.
 */

export interface LibrarySection {
  kind: string;
  label: string;
  description: string;
  html: string;
}

export const SECTION_LIBRARY: LibrarySection[] = [
  {
    kind: 'hero',
    label: 'Hero',
    description: 'Headline, short pitch and a call to action.',
    html: `<section class="mv-hero" data-mv-section="hero" data-mv-id="hero">
  <div class="mv-container">
    <h1 class="mv-hero-title" data-mv-id="hero-title">Say what you make in one line</h1>
    <p class="mv-lead" data-mv-id="hero-lead">One or two sentences about who it is for and why it helps.</p>
    <div class="mv-actions">
      <a class="mv-btn mv-btn-primary" href="#contact" data-mv-id="hero-cta">Get started</a>
      <a class="mv-btn mv-btn-ghost" href="#features" data-mv-id="hero-secondary">See how it works</a>
    </div>
  </div>
</section>`,
  },
  {
    kind: 'features',
    label: 'Features',
    description: 'Three short benefits in cards.',
    html: `<section class="mv-features" id="features" data-mv-section="features" data-mv-id="features">
  <div class="mv-container">
    <h2 data-mv-id="features-title">Why people choose it</h2>
    <div class="mv-grid mv-grid-3">
      <article class="mv-card" data-mv-id="feature-1">
        <h3 data-mv-id="feature-1-title">First benefit</h3>
        <p data-mv-id="feature-1-text">Explain the benefit in a sentence.</p>
      </article>
      <article class="mv-card" data-mv-id="feature-2">
        <h3 data-mv-id="feature-2-title">Second benefit</h3>
        <p data-mv-id="feature-2-text">Explain the benefit in a sentence.</p>
      </article>
      <article class="mv-card" data-mv-id="feature-3">
        <h3 data-mv-id="feature-3-title">Third benefit</h3>
        <p data-mv-id="feature-3-text">Explain the benefit in a sentence.</p>
      </article>
    </div>
  </div>
</section>`,
  },
  {
    kind: 'image-text',
    label: 'Image and text',
    description: 'A picture beside a short story.',
    html: `<section class="mv-split" data-mv-section="image-text" data-mv-id="story">
  <div class="mv-container mv-split-inner">
    <img class="mv-media" src="images/placeholder.svg" alt="Describe the image" data-mv-id="story-image">
    <div>
      <h2 data-mv-id="story-title">The story behind it</h2>
      <p data-mv-id="story-text">A paragraph about how it works or who is behind it.</p>
    </div>
  </div>
</section>`,
  },
  {
    kind: 'gallery',
    label: 'Gallery',
    description: 'A grid of images with captions.',
    html: `<section class="mv-gallery" data-mv-section="gallery" data-mv-id="gallery">
  <div class="mv-container">
    <h2 data-mv-id="gallery-title">Selected work</h2>
    <div class="mv-grid mv-grid-3">
      <figure data-mv-id="gallery-1"><img src="images/placeholder.svg" alt="Project one" data-mv-id="gallery-1-image"><figcaption data-mv-id="gallery-1-caption">Project one</figcaption></figure>
      <figure data-mv-id="gallery-2"><img src="images/placeholder.svg" alt="Project two" data-mv-id="gallery-2-image"><figcaption data-mv-id="gallery-2-caption">Project two</figcaption></figure>
      <figure data-mv-id="gallery-3"><img src="images/placeholder.svg" alt="Project three" data-mv-id="gallery-3-image"><figcaption data-mv-id="gallery-3-caption">Project three</figcaption></figure>
    </div>
  </div>
</section>`,
  },
  {
    kind: 'testimonial',
    label: 'Testimonial',
    description: 'A quote from a customer.',
    html: `<section class="mv-quote" data-mv-section="testimonial" data-mv-id="testimonial">
  <div class="mv-container">
    <blockquote data-mv-id="quote-text">“A short, specific quote from someone you helped.”</blockquote>
    <p class="mv-muted" data-mv-id="quote-author">Name, role at Company</p>
  </div>
</section>`,
  },
  {
    kind: 'pricing',
    label: 'Pricing',
    description: 'Two plans side by side.',
    html: `<section class="mv-pricing" id="pricing" data-mv-section="pricing" data-mv-id="pricing">
  <div class="mv-container">
    <h2 data-mv-id="pricing-title">Simple pricing</h2>
    <div class="mv-grid mv-grid-2">
      <article class="mv-card" data-mv-id="plan-1">
        <h3 data-mv-id="plan-1-name">Starter</h3>
        <p class="mv-price" data-mv-id="plan-1-price">$9 / month</p>
        <p data-mv-id="plan-1-text">For individuals getting started.</p>
        <a class="mv-btn mv-btn-ghost" href="#contact" data-mv-id="plan-1-cta">Choose Starter</a>
      </article>
      <article class="mv-card mv-card-accent" data-mv-id="plan-2">
        <h3 data-mv-id="plan-2-name">Team</h3>
        <p class="mv-price" data-mv-id="plan-2-price">$29 / month</p>
        <p data-mv-id="plan-2-text">For small teams that work together.</p>
        <a class="mv-btn mv-btn-primary" href="#contact" data-mv-id="plan-2-cta">Choose Team</a>
      </article>
    </div>
  </div>
</section>`,
  },
  {
    kind: 'faq',
    label: 'Questions',
    description: 'Frequently asked questions that expand.',
    html: `<section class="mv-faq" data-mv-section="faq" data-mv-id="faq">
  <div class="mv-container">
    <h2 data-mv-id="faq-title">Questions</h2>
    <details data-mv-id="faq-1"><summary data-mv-id="faq-1-q">A common question?</summary><p data-mv-id="faq-1-a">A clear, short answer.</p></details>
    <details data-mv-id="faq-2"><summary data-mv-id="faq-2-q">Another common question?</summary><p data-mv-id="faq-2-a">A clear, short answer.</p></details>
  </div>
</section>`,
  },
  {
    kind: 'cta',
    label: 'Call to action',
    description: 'A closing band with one button.',
    html: `<section class="mv-cta" data-mv-section="cta" data-mv-id="cta">
  <div class="mv-container">
    <h2 data-mv-id="cta-title">Ready when you are</h2>
    <a class="mv-btn mv-btn-primary" href="#contact" data-mv-id="cta-button">Get in touch</a>
  </div>
</section>`,
  },
  {
    kind: 'contact',
    label: 'Contact',
    description: 'Email link and a simple form (sent by your email app).',
    html: `<section class="mv-contact" id="contact" data-mv-section="contact" data-mv-id="contact">
  <div class="mv-container">
    <h2 data-mv-id="contact-title">Contact</h2>
    <p data-mv-id="contact-text">Write to <a href="mailto:hello@example.com" data-mv-id="contact-email">hello@example.com</a></p>
    <form class="mv-form" action="mailto:hello@example.com" method="post" enctype="text/plain" data-mv-id="contact-form">
      <label>Name <input name="name" required autocomplete="name"></label>
      <label>Email <input name="email" type="email" required autocomplete="email"></label>
      <label>Message <textarea name="message" rows="4" required></textarea></label>
      <button class="mv-btn mv-btn-primary" type="submit" data-mv-id="contact-submit">Send</button>
    </form>
  </div>
</section>`,
  },
  {
    kind: 'text',
    label: 'Text',
    description: 'A heading and a paragraph.',
    html: `<section class="mv-text" data-mv-section="text" data-mv-id="text">
  <div class="mv-container">
    <h2 data-mv-id="text-title">A heading</h2>
    <p data-mv-id="text-body">A paragraph of text.</p>
  </div>
</section>`,
  },
];

export const PLACEHOLDER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 500" role="img" aria-label="Placeholder image"><rect width="800" height="500" fill="#e8e6f0"/><path d="M0 380 L220 220 L380 340 L520 250 L800 420 L800 500 L0 500 Z" fill="#c9c4dc"/><circle cx="600" cy="140" r="56" fill="#d9d4ea"/></svg>\n`;

/** Shared styles for library sections. Uses theme tokens with sensible fallbacks. */
export const SECTIONS_CSS = `/* Section library styles (Multiverse Studio). Themed by the --mv-* tokens in theme.css. */
.mv-container { width: min(1120px, 100% - 2 * var(--mv-gutter, 24px)); margin-inline: auto; }
.mv-hero, .mv-features, .mv-split, .mv-gallery, .mv-quote, .mv-pricing, .mv-faq, .mv-cta, .mv-contact, .mv-text { padding-block: var(--mv-section-space, 88px); }
.mv-hero { background: var(--mv-color-surface, #f4f2fa); }
.mv-hero-title { font-family: var(--mv-font-heading, inherit); font-size: clamp(2.4rem, 5vw, 4.2rem); line-height: 1.05; max-width: 16ch; margin: 0 0 20px; }
.mv-lead { font-size: 1.2rem; max-width: 52ch; color: var(--mv-color-muted, #555); margin: 0 0 32px; }
.mv-actions { display: flex; flex-wrap: wrap; gap: 12px; }
.mv-btn { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; padding: 0 22px; border-radius: var(--mv-radius, 10px); font-weight: 600; text-decoration: none; border: 1px solid transparent; cursor: pointer; font: inherit; }
.mv-btn-primary { background: var(--mv-color-primary, #3b3bd6); color: var(--mv-color-on-primary, #fff); }
.mv-btn-ghost { border-color: currentColor; color: var(--mv-color-text, #111); background: transparent; }
.mv-btn:focus-visible { outline: 3px solid var(--mv-color-primary, #3b3bd6); outline-offset: 3px; }
.mv-grid { display: grid; gap: var(--mv-gap, 24px); }
.mv-grid-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.mv-grid-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.mv-card { padding: 28px; border-radius: var(--mv-radius, 10px); background: var(--mv-color-card, #fff); border: 1px solid var(--mv-color-line, #e4e1ee); }
.mv-card-accent { border-color: var(--mv-color-primary, #3b3bd6); }
.mv-card h3 { margin-top: 0; }
.mv-price { font-size: 1.6rem; font-weight: 700; margin: 8px 0; }
.mv-split-inner { display: grid; grid-template-columns: 1fr 1fr; gap: 48px; align-items: center; }
.mv-media, .mv-gallery img { width: 100%; height: auto; border-radius: var(--mv-radius, 10px); display: block; }
.mv-gallery figure { margin: 0; }
.mv-gallery figcaption { margin-top: 8px; color: var(--mv-color-muted, #555); }
.mv-quote blockquote { font-family: var(--mv-font-heading, inherit); font-size: clamp(1.4rem, 3vw, 2rem); margin: 0 0 16px; max-width: 30ch; }
.mv-muted { color: var(--mv-color-muted, #555); }
.mv-faq details { border-bottom: 1px solid var(--mv-color-line, #e4e1ee); padding: 16px 0; }
.mv-faq summary { cursor: pointer; font-weight: 600; }
.mv-cta { background: var(--mv-color-primary, #3b3bd6); color: var(--mv-color-on-primary, #fff); text-align: center; }
.mv-cta .mv-btn-primary { background: var(--mv-color-on-primary, #fff); color: var(--mv-color-primary, #3b3bd6); }
.mv-form { display: grid; gap: 14px; max-width: 520px; }
.mv-form label { display: grid; gap: 6px; font-weight: 600; }
.mv-form input, .mv-form textarea { font: inherit; padding: 10px 12px; border-radius: var(--mv-radius, 10px); border: 1px solid var(--mv-color-line, #cfcbe0); }
@media (max-width: 900px) {
  .mv-grid-3 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .mv-split-inner { grid-template-columns: 1fr; gap: 28px; }
}
@media (max-width: 600px) {
  .mv-grid-2, .mv-grid-3 { grid-template-columns: 1fr; }
  .mv-hero, .mv-features, .mv-split, .mv-gallery, .mv-quote, .mv-pricing, .mv-faq, .mv-cta, .mv-contact, .mv-text { padding-block: 56px; }
}
`;
