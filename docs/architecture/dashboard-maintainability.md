# Dashboard Maintainability Notes

The dashboard's UI is built on top of Tailwind CSS and custom properties (CSS variables). The latest updates align the theme to the landing page, but how do we scale this for multiple themes or internationalization (i18n)?

## 1. Multiple Themes (Theming)

Currently, all the design tokens are declared in the `:root` block of `packages/dashboard/src/styles/index.css`:

```css
:root {
  --bg: #060a14;
  --bg-elevated: #0c1222;
  --text: #f0f4ff;
  --primary: #00f5d4;
  /* ... */
}
```

**How to add a Light Theme (or other themes):**
To make the app support multiple themes easily, avoid hardcoding `rgba(12, 18, 34)` and instead map all values to variables.

1. Extract hex colors into RGB format so they can be injected into Tailwind's `rgb()` / `rgba()` natively:
```css
:root {
  --primary-rgb: 0, 245, 212;
  --bg-rgb: 6, 10, 20;
}

[data-theme='light'] {
  --primary-rgb: 91, 43, 238; /* Old purple scale */
  --bg-rgb: 255, 255, 255; 
}
```

2. Inside your Tailwind config (`packages/dashboard/src/styles/index.css` depending on v4 format) or throughout `.css` files, use elements like `background: rgba(var(--bg-rgb), 0.8)`. 

This will automatically re-skin the entire CSS without needing to modify the React components at all when `document.documentElement.setAttribute('data-theme', 'light')` is toggled.

## 2. Localization and i18n
The dashboard is a Client-Side React Application. Adding multiple translations can be achieved by removing hardcoded text from the components.

**Recommended Steps:**
1. Install `react-i18next` and `i18next`:
   ```bash
   npm install react-i18next i18next
   ```
2. Create mapping files for text (e.g. `packages/dashboard/src/locales/en.json`, `es.json`).
3. Inside your React components, wrap all presentation text in the `UseTranslation` hook.

```tsx
import { useTranslation } from 'react-i18next';

export function LoginPage() {
  const { t } = useTranslation();
  return (
    <div>
      <label>{t('login.email_address')}</label>
      {/* ... */}
    </div>
  );
}
```

This completely decouples the design and functional logic from the copywriting, drastically improving maintainability.
