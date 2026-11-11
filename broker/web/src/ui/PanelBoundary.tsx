// A section that throws while drawing shows an error in its own panel instead of taking
// the whole screen down. React only offers this as a class component.

import { Component, type ReactNode } from "react";

import { Panel } from "./Shell.tsx";

export class PanelBoundary extends Component<{ name: string; children: ReactNode }, { error: Error | undefined }> {
  override state = { error: undefined as Error | undefined };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error): void {
    console.error(`${this.props.name} failed:`, error);
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <Panel title={this.props.name}>
        <p className="empty">This section hit an error.</p>
        <button type="button" className="link" onClick={() => this.setState({ error: undefined })}>
          Try again
        </button>
      </Panel>
    );
  }
}
