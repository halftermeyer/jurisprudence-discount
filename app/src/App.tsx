import { useState } from "react";
import { Tabs } from "@neo4j-ndl/react";
import ExploreTab from "./components/ExploreTab";
import DecideTab from "./components/DecideTab";
import ScenariosTab from "./components/ScenariosTab";
import ChatTab from "./components/ChatTab";
import QueryAuditDrawer from "./components/QueryAuditDrawer";
import "./App.css";

function App() {
  const [activeTab, setActiveTab] = useState("explore");

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="header-content">
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <h1>
              <span className="header-icon">&#9878;</span> Jurisprudence
            </h1>
          </div>
          <p className="subtitle">
            Policy or precedent — every discount decision explained, from the graph
          </p>
        </div>
      </header>

      <div className="app-tabs">
        <Tabs fill="underline" onChange={setActiveTab} value={activeTab}>
          <Tabs.Tab id="explore">Explore</Tabs.Tab>
          <Tabs.Tab id="decide">Decide</Tabs.Tab>
          <Tabs.Tab id="scenarios">Scenarios</Tabs.Tab>
          <Tabs.Tab id="chat">Assistant</Tabs.Tab>
        </Tabs>
      </div>

      <main className="app-main">
        {activeTab === "explore" && <ExploreTab />}
        {activeTab === "decide" && <DecideTab />}
        {activeTab === "scenarios" && <ScenariosTab />}
        {activeTab === "chat" && <ChatTab />}
      </main>

      <QueryAuditDrawer />
    </div>
  );
}

export default App;
