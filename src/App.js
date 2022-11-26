import { BrowserRouter as Router, Route, Routes } from "react-router-dom";
import Home from "./page/Home";
import Product from "./page/Product";
import Prod from "./page/Prod";
function App() {
  return (
    <Router>
      <Routes>
        <Route path="" element={<Home />} />
        <Route path="/product/:id" element={<Prod />} />
        <Route path="/product/" element={<Product />} />
      </Routes>
    </Router>
  );
}

export default App;
