import { BrowserRouter as Router, Route, Routes } from "react-router-dom";
import Home from "./page/Home";
import Product from "./page/Product";
import Prod from "./page/Prod";
import Layout from "./components/Layout";
import Cart from "./components/Cart";
import Reg from "./components/Reg";
import Carosel from "./components/Carosel";
function App() {
  return (
    <Router>
      <Layout>
        <Routes>
          <Route path="" element={<Home />} />
          <Route path="/product/:id" element={<Prod />} />
          <Route path="/product/" element={<Product />} />
          <Route path="/cart" element={<Cart />} />
          <Route path="/carosel" element={<Carosel />} />
          <Route path="/reg" element={<Reg />} />
        </Routes>
      </Layout>
    </Router>
  );
}

export default App;
