import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiKeyReveal } from "../ApiKeyReveal.js";

describe("ApiKeyReveal Component", () => {
  const defaultProps = {
    open: true,
    title: "New Agent Key",
    description: "Please save this key.",
    apiKey: "ak_test_123",
    onClose: vi.fn(),
  };

  it("renders correctly when open", () => {
    render(<ApiKeyReveal {...defaultProps} />);
    expect(screen.getByText("New Agent Key")).toBeInTheDocument();
    expect(screen.getByText("ak_test_123")).toBeInTheDocument();
  });

  it("does not render when closed", () => {
    render(<ApiKeyReveal {...defaultProps} open={false} />);
    expect(screen.queryByText("New Agent Key")).not.toBeInTheDocument();
  });

  it("copies API key to clipboard", async () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: {
        writeText: writeTextMock,
      },
    });

    render(<ApiKeyReveal {...defaultProps} />);
    const copyButton = screen.getByRole("button", { name: /Copy key/i });
    fireEvent.click(copyButton);

    expect(writeTextMock).toHaveBeenCalledWith("ak_test_123");
    expect(await screen.findByText("Copied")).toBeInTheDocument();
  });

  it("requires confirmation checkbox to be checked before closing", () => {
    const onClose = vi.fn();
    render(<ApiKeyReveal {...defaultProps} onClose={onClose} />);
    
    const closeButton = screen.getByRole("button", { name: /I saved this key/i });
    expect(closeButton).toBeDisabled();

    fireEvent.click(closeButton);
    expect(onClose).not.toHaveBeenCalled();

    const checkbox = screen.getByRole("checkbox");
    fireEvent.click(checkbox);
    
    expect(closeButton).not.toBeDisabled();
    fireEvent.click(closeButton);
    expect(onClose).toHaveBeenCalled();
  });
});
