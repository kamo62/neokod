import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import { beforeAll, describe, expect, it, vi } from "vite-plus/test";

import ChatMarkdown, { CHAT_MARKDOWN_SANITIZE_SCHEMA, MarkdownImage } from "./ChatMarkdown";

const TRUSTED = new Set(["https://app.example"]);

describe("MarkdownImage", () => {
  it("renders a remote image as a link with a Load image button", () => {
    const markup = renderToStaticMarkup(
      <MarkdownImage
        src="https://evil.example/leak?q=1"
        alt="chart"
        baseUrl="https://app.example/"
        trustedOrigins={TRUSTED}
      />,
    );
    expect(markup).toContain("Load image");
    expect(markup).toContain("evil.example");
    expect(markup).not.toContain("<img");
  });

  it("renders a trusted asset as an img with no-referrer", () => {
    const markup = renderToStaticMarkup(
      <MarkdownImage
        src="https://app.example/a.png"
        alt="logo"
        baseUrl="https://app.example/"
        trustedOrigins={TRUSTED}
      />,
    );
    expect(markup).toContain("<img");
    expect(markup).toContain('referrerPolicy="no-referrer"');
  });

  it("sanitize schema keeps event handlers and scripts out and leaves the image to the component", () => {
    const markup = renderToStaticMarkup(
      <ReactMarkdown
        rehypePlugins={[rehypeRaw, [rehypeSanitize, CHAT_MARKDOWN_SANITIZE_SCHEMA]]}
        components={{
          img: (properties) => (
            <MarkdownImage
              src={properties.src as string}
              alt={properties.alt}
              baseUrl="https://app.example/"
              trustedOrigins={TRUSTED}
            />
          ),
        }}
      >
        {`![x](https://evil.example/a.png)\n\n<img src="https://evil.example/b.png" onerror="alert(1)">\n\n<script>alert(1)</script>`}
      </ReactMarkdown>,
    );
    expect(markup).not.toContain("onerror");
    expect(markup).not.toContain("<script");
    expect(markup).not.toContain("<img");
    expect(markup.split("Load image")).toHaveLength(3);
  });
});

describe("chat external links", () => {
  function matchMedia() {
    return {
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    };
  }

  beforeAll(() => {
    const classList = {
      add: () => {},
      remove: () => {},
      toggle: () => {},
      contains: () => false,
    };

    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
      clear: () => {},
    });
    vi.stubGlobal("window", {
      matchMedia,
      addEventListener: () => {},
      removeEventListener: () => {},
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        callback(0);
        return 0;
      },
      cancelAnimationFrame: () => {},
      desktopBridge: undefined,
    });
    vi.stubGlobal("document", {
      documentElement: {
        classList,
        offsetHeight: 0,
      },
    });
  });

  it("external link renders no third-party favicon", () => {
    const markup = renderToStaticMarkup(
      <ChatMarkdown text="[x](https://secret-internal.corp.example/p)" cwd={undefined} />,
    );
    expect(markup).not.toContain("google.com");
    expect(markup).not.toContain("favicons");
    expect(markup).toContain("chat-markdown-link-favicon");
  });
});
