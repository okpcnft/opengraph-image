import chromium from "chrome-aws-lambda";
import type { NextApiRequest, NextApiResponse } from "next";
import { Browser } from "puppeteer";
import type { Browser as BrowserCore } from "puppeteer-core";

const allowedHostnames = [/^https:\/\/.*\.okpc\.app\//];

if (process.env.NODE_ENV !== "production") {
  allowedHostnames.push(/^http:\/\/localhost(:\d+)?\//);
}

const getBrowserInstance = async () => {
  const executablePath = await chromium.executablePath;

  if (!executablePath) {
    // running locally
    const puppeteer = await import("puppeteer");
    return puppeteer.launch({
      args: chromium.args,
      headless: true,
      ignoreHTTPSErrors: true,
    });
  }

  return chromium.puppeteer.launch({
    executablePath,
    args: chromium.args,
    headless: chromium.headless,
    ignoreHTTPSErrors: true,
  });
};

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  const url = req.query.url as string | undefined;
  if (!url) {
    res.status(400).json({ error: { code: "MISSING_URL" } });
    return;
  }

  if (!allowedHostnames.some((hostname) => hostname.test(url))) {
    res.status(400).json({ error: { code: "INVALID_URL" } });
    return;
  }

  const fallback =
    typeof req.query.fallback === "string" ? req.query.fallback : null;

  const pixelDensity = parseInt(req.query.pixelDensity as string) || 1;

  let browser: Browser | BrowserCore | null = null;

  try {
    browser = await getBrowserInstance();
    const page = await browser.newPage();
    await page.setViewport({
      width: 1280,
      height: 720,
      deviceScaleFactor: pixelDensity,
    });
    page.setDefaultNavigationTimeout(1000 * 10);

    await page.goto(url.toString());
    await page.waitForNetworkIdle();

    await page.waitForSelector("#opengraph-image", { timeout: 500 });
    const element = await page.$("#opengraph-image");

    if (!element) {
      throw new Error("No #opengraph-image element found at path");
    }

    const imageBuffer = await element.screenshot({ type: "png" });

    // s-maxage:
    //   images are considered "fresh" for 8 hours
    // stale-while-revalidate:
    //   allow serving stale images for up to 24 hours, with cache refresh in background
    //
    // anything outside this window will cause the browser to wait to regenerate the image
    // so we might consider increasing the stale-while-revalidate if we are okay with the
    // first request serving a very stale image
    res.setHeader(
      "Cache-Control",
      `s-maxage=${60 * 60 * 8}, stale-while-revalidate=${60 * 60 * 24}`
    );

    res.setHeader("Content-Type", "image/png");
    res.send(imageBuffer);
  } catch (error: unknown) {
    // TODO: log this to some error tracking service?
    console.error("error while generating opengraph image", error);

    if (fallback) {
      res.redirect(fallback);
      return;
    }

    res.status(500).json({
      error: {
        code: "UNEXPECTED_ERROR",
        message: (error as any).toString(),
      },
    });
  } finally {
    if (browser !== null) {
      await browser.close();
    }
  }
};

export default handler;
