import { expect, test } from '@playwright/test'

const themes = ['light', 'dark'] as const

for (const theme of themes) {
  test(`component gallery — ${theme}`, async ({ page }) => {
    await page.goto(`/?view=gallery&theme=${theme}`)

    await expect(
      page.getByRole('heading', { name: 'Component gallery' }),
    ).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)

    // Web fonts must settle before the first pixels are recorded.
    await page.evaluate(() => document.fonts.ready)

    await expect(page).toHaveScreenshot(`gallery-${theme}.png`, {
      animations: 'disabled',
      caret: 'hide',
    })
  })
}
