import React from "react";

class WidgetErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error, info) {
    console.error("Widget crashed:", error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="widget-card widget-error">
          <h3>Widget Error</h3>
          <p>This widget failed to load.</p>
        </div>
      );
    }

    return this.props.children;
  }
}

export default WidgetErrorBoundary;