import { BrowserRouter as Router, Route, Routes } from "react-router-dom";
import Home from "./page/Home";
import Product from "./page/Product";
import Prod from "./page/Prod";
import Layout from "./components/Layout";
import Cart from "./components/Cart";
import Reg from "./components/Reg";
import Carosel from "./components/Carosel";
import Profile from "./components/Profile";
import Addproduct from "./page/Addproduct";
import Editproduct from "./page/Editproduct";
import Productlist from "./page/Productlist";
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
          <Route path="/profile" element={<Profile />} />
          <Route path="/admin" element={<Addproduct />} />
          <Route path="/productlist" element={<Productlist />} />
          <Route path="/edit/:key" element={<Editproduct />} />
        </Routes>
      </Layout>
    </Router>
  );
}

export default App;
