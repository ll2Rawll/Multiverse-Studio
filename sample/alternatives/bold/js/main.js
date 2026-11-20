// Mobile navigation toggle.
const toggle = document.querySelector('.nav-toggle');
const links = document.getElementById('nav-links');

if (toggle && links) {
  toggle.addEventListener('click', () => {
    const open = links.classList.toggle('is-open');
    toggle.setAttribute('aria-expanded', String(open));
  });
}

// Newsletter signup in the footer (demo only: nothing is sent anywhere).
const signup = document.querySelector('[data-newsletter]');

if (signup) {
  const button = signup.querySelector('.fb-button');
  const input = signup.querySelector('input');
  const thanks = document.querySelector('.fb-thanks');
  button.addEventListener('click', () => {
    if (!input.value.includes('@')) {
      input.focus();
      return;
    }
    signup.hidden = true;
    thanks.hidden = false;
  });
}
