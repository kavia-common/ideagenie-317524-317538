import { render, screen } from "@testing-library/react";
import App from "./App";

test("renders IdeaGenie header", () => {
  render(<App />);
  expect(screen.getByText(/IdeaGenie/i)).toBeInTheDocument();
  expect(screen.getByText(/AI Idea Generator/i)).toBeInTheDocument();
});
