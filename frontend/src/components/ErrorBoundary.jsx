import { Component } from 'react';

export default class ErrorBoundary extends Component {
  state = { hasError: false, error: null, info: null };

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    console.error('ErrorBoundary caught:', error, info);
    this.setState({ info });
  }

  render() {
    if (this.state.hasError) {
      const { error, info } = this.state;
      // Surface the real error in dev so the failing component is identifiable
      // instead of hidden behind a generic message.
      const isDev = typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.DEV;
      const detail = error ? (error.stack || error.message || String(error)) : '';
      const componentStack = info?.componentStack || '';
      return (
        <div style={{ padding:40, textAlign:'center', fontFamily:'sans-serif' }}>
          <div style={{ fontSize:48, marginBottom:16 }}>⚠️</div>
          <h2 style={{ color:'#dc2626', margin:'0 0 8px' }}>Something went wrong</h2>
          <p style={{ color:'#6b7280', marginBottom:24, fontSize:14 }}>
            Something went wrong loading this page. Please try again or contact support.
          </p>
          <button
            onClick={() => { this.setState({ hasError:false, error:null, info:null }); window.location.reload(); }}
            style={{ padding:'10px 24px', background:'#6366f1', color:'#fff',
              border:'none', borderRadius:8, cursor:'pointer', fontSize:14, fontWeight:600 }}>
            Reload Page
          </button>
          {isDev && (detail || componentStack) && (
            <pre style={{ marginTop:24, textAlign:'left', maxWidth:900, marginLeft:'auto', marginRight:'auto',
              background:'#1f2937', color:'#fca5a5', padding:16, borderRadius:8, fontSize:12,
              overflow:'auto', whiteSpace:'pre-wrap', lineHeight:1.5 }}>
              {detail}
              {componentStack ? `\n\n--- Component stack ---${componentStack}` : ''}
            </pre>
          )}
        </div>
      );
    }
    return this.props.children;
  }
}
