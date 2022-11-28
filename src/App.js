import { BrowserRouter as Router, Route, Routes } from "react-router-dom";
import Home from "./page/Home";
import Product from "./page/Product";
import Prod from "./page/Prod";
import Layout from "./components/Layout";
import Cart from "./components/Cart";
function App() {
  return (
    <Router>
      <Layout>
        <Routes>
          <Route path="" element={<Home />} />
          <Route path="/product/:id" element={<Prod />} />
          <Route path="/product/" element={<Product />} />
          <Route path="/cart" element={<Cart />} />
        </Routes>
      </Layout>
    </Router>
  );
}

export default App;
