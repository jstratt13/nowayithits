// Home page — landing surface when you load the root URL or click the
// brand wordmark in the header. Contents will be filled in by Jordan
// in a follow-up; for now this is just a placeholder shell so the
// routing + brand-click behavior can be verified.

export default function Home() {
  return (
    <div className="page-main">
      <section className="home-page">
        <div className="home-intro">
          <span className="home-eyebrow">Home</span>
          <h1 className="home-title">No Way It Hits</h1>
          <p className="home-lede">
            Home page content coming soon. Use the nav above to jump to{' '}
            <strong>Predictions</strong> or <strong>Tracker</strong>.
          </p>
        </div>
      </section>
    </div>
  );
}
